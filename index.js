// v1.3.8 gr8r-videouploads-worker added key caching function and updated both DB1 calls to utilize
// ADDED: utilization of sanitize function for 2nd DB1 call
// v1.3.7 gr8r-videouploads-worker revised santizeForDB1 function for null and empty values

function sanitizeForDB1(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, value]) =>
      value !== undefined &&
      value !== null &&
      value !== ""
    )
  );
}
let cachedDB1Key = null;

async function getDB1InternalKey(env) {
  if (!cachedDB1Key) {
    cachedDB1Key = await env.DB1_INTERNAL_KEY.get();
  }
  return cachedDB1Key;
}

export default {
  async fetch(request, env, ctx) {
    console.log('[videouploads-worker] Handler triggered');

    const contentType = request.headers.get('content-type') || 'none';
    console.log('[videouploads-worker] Content-Type:', contentType);

    if (request.method !== 'POST') {
      console.log('[videouploads-worker] Non-POST request received:', request.method);
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/upload-video') {
      try {
        // Accept JSON body instead of multipart/form-data
        const body = await request.json();
        const { filename, title, videoType, scheduleDateTime = "" } = body;

        console.log('[videouploads-worker] Parsed fields:');
        console.log('  title:', title);
        console.log('  videoType:', videoType);
        console.log('  scheduleDateTime:', scheduleDateTime);
        console.log('  filename:', filename);

        if (!(filename && title && videoType)) {
          return new Response("Missing required fields", { status: 400 });
        }

        const objectKey = filename; // CHANGED: Using filename directly
        const publicUrl = `https://videos.gr8r.com/${objectKey}`; // CHANGED: Constructing R2 URL

        // Check that the file exists in R2 without downloading it
        const object = await env.VIDEO_BUCKET.get(objectKey);
        if (!object) {
          await logToGrafana(env, "error", "R2 file missing", { title, objectKey });
          return new Response("Video file not found in R2", { status: 404 });
        }

        // Attempt to read metadata from R2 object
        let contentType = object.httpMetadata?.contentType || "unknown";
        let contentLength = object.size || null;
        // let humanSize = contentLength ? `${(contentLength / 1048576).toFixed(2)} MB` : null; //commenting out since field is depracated

        // First Airtable update with new fields
        const airtableResponse = await env.AIRTABLE.fetch(new Request("https://internal/api/airtable/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            table: "tblQKTuBRVrpJLmJp",
            title,
            fields: {
              "R2 URL": publicUrl,
              "Schedule Date-Time": scheduleDateTime,
              "Video Type": videoType,
              "Video Filename": filename,
              "Content Type": contentType,
              // "Video File Size": humanSize,  //commenting out since field is depracated
              "Video File Size Number": contentLength,
              "Status": "Working"
            }
          })
        }));

        let airtableData = null;
        if (airtableResponse.ok) {
          airtableData = await airtableResponse.json();
        } else {
          const text = await airtableResponse.text();
          await logToGrafana(env, "error", "Airtable create New Video failed", { title, airtableResponseText: text });
          throw new Error(`Airtable create failed: ${text}`);
        }

        let db1Data = null;
        await logToGrafana(env, "info", "Airtable New Video Entry", { 
          title, 
          db1response: db1Data
        });

        // DB1 update to mirror Airtable

        const db1Body = sanitizeForDB1({
          title,
          video_type: videoType,
          scheduled_at: scheduleDateTime,
          r2_url: publicUrl,
          content_type: contentType,
          video_filename: filename,
          file_size_bytes: contentLength,
          status: "Working"
        });

console.log("[DB1 Body] Payload:", JSON.stringify(db1Body, null, 2));
        const db1Key = await getDB1InternalKey(env);
        const db1Response = await env.DB1.fetch("https://gr8r-db1-worker/db1/videos", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${db1Key}`,
          },
          body: JSON.stringify(db1Body),
        });

                const text = await db1Response.text();
                
                try {
                  db1Data = JSON.parse(text);
                } catch {
                  db1Data = { raw: text };
                }

        if (!db1Response.ok) {
          await logToGrafana(env, "error", "DB1 video upsert failed", {
            title,
            db1Status: db1Response.status,
            db1ResponseText: text
          });
          throw new Error(`DB1 update failed: ${text}`);
        }

        await logToGrafana(env, "info", "DB1 New Video Entry", {
          title,
          db1Response: db1Data
        });


        // Rev.ai logic unchanged
        const revaiResponse = await env.REVAI.fetch(new Request("https://internal/api/revai/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            media_url: publicUrl,
            metadata: title,
            callback_url: "https://callback.gr8r.com/api/revai/callback"
          })
        }));

        const revaiJson = await revaiResponse.json();

        if (!revaiResponse.ok || !revaiJson.id) {
          await logToGrafana(env, "error", "Rev.ai job failed", {
            title,
            revaiStatus: revaiResponse.status,
            revaiResponse: revaiJson
          });
          return new Response(JSON.stringify({
            error: "Rev.ai job failed",
            message: revaiJson
          }), {
            status: 502,
            headers: { "Content-Type": "application/json" }
          });
        }

        await logToGrafana(env, "info", "Rev.ai job triggered", { title, revaiJobId: revaiJson.id });

        // Airtable update for Rev.ai Transcript ID
        await env.AIRTABLE.fetch(new Request("https://internal/api/airtable/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            table: "tblQKTuBRVrpJLmJp",
            title,
            fields: {
              "Status": "Pending Transcription",
              "Transcript ID": revaiJson.id
            }
          })
        }));
        await logToGrafana(env, "info", "Transcript ID logged", {
          title,
          revaiJobId: revaiJson.id
        });

        // DB1 follow-up update for Rev.ai job
        try {
         const db1FollowupBody = sanitizeForDB1({
          title,
          status: "Pending Transcription",
          transcript_id: revaiJson.id
          });

          const db1FollowupResponse = await env.DB1.fetch("https://gr8r-db1-worker/db1/videos", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${db1Key}` // Reuse from earlier
          },
          body: JSON.stringify(db1FollowupBody)
          });

          const text = await db1FollowupResponse.text();
          let db1FollowupData = null;

        try {
          db1FollowupData = JSON.parse(text);
        } catch {
          db1FollowupData = { raw: text };
        }

        if (!db1FollowupResponse.ok) {
          await logToGrafana(env, "error", "DB1 transcript update failed", {
            title,
            revaiJobId: revaiJson.id,
            db1Status: db1FollowupResponse.status,
            db1ResponseText: text
          });
          throw new Error(`DB1 transcript update failed: ${text}`);
        }

        await logToGrafana(env, "info", "DB1 Transcript ID logged", {
          title,
          revaiJobId: revaiJson.id,
          db1Response: db1FollowupData
        });
        

                } catch (err) {
                  await logToGrafana(env, "error", "DB1 transcript update exception", {
                    title,
                    revaiJobId: revaiJson.id,
                    error: err.message,
                    stack: err.stack
                  });
                  throw err;
                }


        // RETAINED: Final response to Apple Shortcut
        const responseBody = {
          message: "Video upload complete",
          objectKey,
          publicUrl,
          title,
          scheduleDateTime,
          videoType,
          fileSizeMB: contentLength ? parseFloat((contentLength / 1048576).toFixed(2)) : null,
          contentType,
          transcriptId: revaiJson.id,
          airtableData,
          db1Data
        };

        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });

      } catch (err) {
        await logToGrafana(env, "error", "Video upload error", {
          error: err.message,
          name: err.name,
          stack: err.stack
        });

        return new Response(JSON.stringify({
          error: "Unhandled upload failure",
          message: err.message,
          name: err.name,
          stack: err.stack
        }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    return new Response("Forbidden", { status: 403 });
  }
};

// RETAINED: Grafana logging function
async function logToGrafana(env, level, message, meta = {}) {
  try {
    await env.GRAFANA.fetch(new Request("https://internal/api/grafana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level,
        message,
        meta: {
          source: "gr8r-videouploads-worker",
          service: "video-upload",
          ...meta
        }
      })
    }));
  } catch (err) {
    console.error("Grafana logging failed", err);
  }
}
