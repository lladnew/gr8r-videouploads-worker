// v1.3.0 gr8r-videouploads-worker
// CHANGED: Switched from multipart/form-data to application/json
// REMOVED: File blob handling and R2 upload logic
// ADDED: Uses filename to build public URL and validate existence
// ADDED: Pulls metadata from R2 for Airtable logging

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
        // CHANGED: Accept JSON body instead of multipart/form-data
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

        // ADDED: Check that the file exists in R2 without downloading it
        const object = await env.VIDEO_BUCKET.get(objectKey);
        if (!object) {
          await logToGrafana(env, "error", "R2 file missing", { title, objectKey });
          return new Response("Video file not found in R2", { status: 404 });
        }

        // ADDED: Attempt to read metadata from R2 object
        let contentType = object.httpMetadata?.contentType || "unknown";
        let contentLength = object.size || null;
        let humanSize = contentLength ? `${(contentLength / 1048576).toFixed(2)} MB` : null;

        // CHANGED: First Airtable update with new fields
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
              "Video File Size": humanSize,
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

        await logToGrafana(env, "info", "Airtable New Video Entry", { title });

        // RETAINED: Rev.ai logic unchanged
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

        // RETAINED: Airtable update for Rev.ai Transcript ID
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
          airtableData
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
