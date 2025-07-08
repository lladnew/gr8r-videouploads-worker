// v1.1.8 gr8r-videouploads-worker
// added support for hash as a provided field as well as logging of hash
// v1.1.7 gr8r-videouploads-worker
// CHANGED: Moved formData parsing above early skip to access actual file extension
// CHANGED: Early R2 skip now uses file.name-derived extension instead of hardcoded ".mov"
// RETAINED: All logic paths and variable names
// RETAINED: Only one declaration of `prefix`
// RETAINED: Original file hash and objectKey logic structure
// v1.1.6 gr8r-videouploads-worker
// UPDATE to use airtable table ID rather than table name
// Reordered Airtable update to start before Rev.ai
// ADDED: Second Airtable update after Rev.ai job start to log Transcript ID and set status
// ADDED: Grafana log "Transcript ID logged" after second Airtable update
// v1.1.5 gr8r-videouploads-worker
// - FIXED: Airtable response parsing now handles non-JSON (text) error bodies gracefully
// - ADDED: Logs and throws clear error if Airtable returns non-2xx response
// - RETAINED: All functionality from v1.1.4 and prior
// v1.1.4 gr8r-videouploads-worker
// - IMPROVED: Outer catch block now logs full error object (message, name, stack) to Grafana
// - ADDED: JSON error response body includes message, name, and stack for Apple Shortcut inspection
// - RETAINED: All prior features and logging behavior from v1.1.3
// v1.1.3 gr8r-videouploads-worker
// - ADDED: Captures and sends Rev.ai job ID to Airtable ("Transcript ID")
// - ADDED: Sets "Status" field to "Working" in Airtable record
// - CHANGED: Uses SHA-1 hash of file content to generate stable R2 object key
// - ADDED: Skips R2 upload if file with same hash already exists
// - RETAINED: All existing Airtable fields and functionality
// v1.1.2 gr8r-videouploads-worker
// - CHANGED: Captures Rev.ai job error response and propagates to Apple Shortcut
// - ADDED: Logs Rev.ai error status and body to Grafana if transcription fails
// v1.1.1 gr8r-videouploads-worker
// v1.1.0 gr8r-videouploads-worker
// - ADDED: Made scheduleDateTime optional with empty string default
// - ADDED: Captured and returned airtable-worker response in JSON output
// - RETAINED: Existing R2, Rev.ai, Airtable, and Grafana functionality
// v1.0.9 gr8r-videouploads-worker
// - FIXED: Restored proper Rev.ai payload format
// - ADDED: Hardcoded callback_url to https://callback.gr8r.com/api/revai/callback
// - RETAINED: title, scheduleDateTime, and videoType in metadata
// v1.0.8 gr8r-videouploads-worker
// - REPLACED env.R2_PUBLIC_HOST with hardcoded videos.gr8r.com for public URL
// - WRAPPED Rev.ai fetch in try/catch to prevent silent failures
// - WRAPPED Airtable fetch in try/catch to ensure error visibility
// - LOGS success/failure outcomes from downstream fetches to Grafana
// v1.0.7 gr8r-videouploads-worker
// - REMOVED dummy URLs and RESTORED real service bindings for Airtable, Rev.ai, and Grafana
// - ADDED full confirmation logs
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    if (pathname === '/upload-video' && request.method === 'POST') {
      try {
        const contentType = request.headers.get("content-type") || "";
        if (!contentType.includes("multipart/form-data")) {
          return new Response("Expected multipart/form-data", { status: 400 });
        }

        // REQUIRED EARLY: to derive correct file extension before objectKey construction
        const formData = await request.formData();
        const file = formData.get("video");

        if (!file) {
          return new Response("Missing file", { status: 400 });
        }

        const title = formData.get("title");
        const scheduleDateTime = formData.get("scheduleDateTime") || "";
        const videoType = formData.get("videoType");

        if (!(title && videoType)) {
          return new Response("Missing required fields", { status: 400 });
        }

        const fileExt = file.name?.split('.').pop() || 'bin';
        if (!file.name) {
        await logToGrafana(env, "warn", "Missing file.name in upload; defaulted extension to .bin", {});
        }

        const providedHash = formData.get("hash") || searchParams.get("sha1");
        await logToGrafana(env, "debug", "Hash input method", {
        fromForm: !!formData.get("hash"),
        fromQuery: !!searchParams.get("sha1"),
        providedHash
        });

        const prefix = searchParams.get("prefix") || "";

        let objectKey = "";
        if (providedHash) {
          objectKey = `${prefix}${providedHash}.${fileExt}`;
          const existing = await env.VIDEO_BUCKET.head(objectKey);
          if (existing) {
            const publicUrl = `https://videos.gr8r.com/${objectKey}`;
            await logToGrafana(env, "info", "Skipped R2 upload (pre-check hit)", { objectKey });
            return new Response(JSON.stringify({
              message: "Video already exists, no upload needed.",
              objectKey,
              publicUrl,
              skipped: true
            }), {
              status: 200,
              headers: { "Content-Type": "application/json" }
            });
          }
        }

        // HASHING if not already skipped
        let hashHex = "";
        if (providedHash) {
          hashHex = providedHash;
          objectKey = `${prefix}${hashHex}.${fileExt}`;
        } else {
          const fileBuffer = await file.arrayBuffer();
          const hashArray = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", fileBuffer)));
          hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
          objectKey = `${prefix}${hashHex}.${fileExt}`;
        }

        const publicUrl = `https://videos.gr8r.com/${objectKey}`;

        // Check again in case early check didn’t fire (no hash)
        const existing = await env.VIDEO_BUCKET.get(objectKey);
        if (!existing) {
          await env.VIDEO_BUCKET.put(objectKey, file.stream(), {
            httpMetadata: { contentType: file.type },
            customMetadata: { title, scheduleDateTime, videoType }
          });
          await logToGrafana(env, "info", "R2 upload successful", { objectKey, title });
        } else {
          await logToGrafana(env, "info", "Skipped R2 upload (already exists)", { objectKey, title });
        }
// Update Airtable and capture response
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
              "Video Filename": `${title}.${fileExt}`,
              "Content Type": file.type,
              "Video File Size": `${(file.size / 1048576).toFixed(2)} MB`,
              "Video File Size Number": file.size,
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
// Trigger Rev.ai transcription job and get job ID 
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

        const responseBody = {
          message: "Video upload complete",
          objectKey,
          publicUrl,
          title,
          scheduleDateTime,
          videoType,
          fileSizeMB: parseFloat((file.size / 1048576).toFixed(2)),
          contentType: file.type,
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
