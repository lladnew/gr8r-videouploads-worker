// v1.1.2 gr8r-videouploads-worker
// ADDED: Rev.ai check for success (v1.1.2)
// ADDED: R2 video replacement logic using title-based prefix check (v1.1.1)
// RETAINED: Optional scheduleDateTime, airtableData response, existing functionality (v1.1.1)
// ADDED: Made scheduleDateTime optional with empty string default (v1.1.0)
// ADDED: Captured and returned airtable-worker response in JSON output (v1.1.0)
// RETAINED: Existing R2, Rev.ai, Airtable, and Grafana functionality (v1.1.0)
// FIXED: Restored proper Rev.ai payload format (v1.0.9)
//   - Sends `media_url`, `metadata`, and `callback_url` (v1.0.9)
// ADDED: Hardcoded callback_url to https://callback.gr8r.com/api/revai/callback (v1.0.9)
// RETAINED: title, scheduleDateTime, and videoType in metadata (v1.0.9)
// PRESERVED: Grafana logging for all steps (v1.0.9)

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

        const formData = await request.formData();
        const file = formData.get("video");
        const title = formData.get("title");
        const scheduleDateTime = formData.get("scheduleDateTime") || "";
        const videoType = formData.get("videoType");

        if (!(file && title && videoType)) {
          return new Response("Missing required fields", { status: 400 });
        }

        const fileExt = (file.name || 'upload.mov').split('.').pop();
        const prefix = searchParams.get("prefix") || "";
        let objectKey = `${prefix}${Date.now()}-${title.replace(/\s+/g, "_")}.${fileExt}`;

        // Check for existing video in R2
        const titlePrefix = `${prefix}${title.replace(/\s+/g, "_")}.`;
        const listResponse = await env.VIDEO_BUCKET.list({ prefix: titlePrefix });
        if (listResponse.objects.length > 0) {
          objectKey = listResponse.objects[0].key; // Use existing key to overwrite
          await logToGrafana(env, "info", "Found existing video, overwriting", { objectKey, title });
        }

        const publicUrl = `https://videos.gr8r.com/${objectKey}`;

        // Upload to R2
        await env.VIDEO_BUCKET.put(objectKey, file.stream(), {
          httpMetadata: { contentType: file.type },
          customMetadata: { title, scheduleDateTime, videoType }
        });

        await logToGrafana(env, "info", "R2 upload successful", { objectKey, title });

        // Update Airtable and capture response
        const airtableResponse = await env.AIRTABLE.fetch(new Request("https://internal/api/airtable/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            table: "Video posts",
            title,
            fields: {
              "R2 URL": publicUrl,
              "Schedule Date-Time": scheduleDateTime,
              "Video Type": videoType,
              "Video Filename": `${title}.${fileExt}`,
              "Content Type": file.type,
              "Video File Size": `${(file.size / 1048576).toFixed(2)} MB`,
              "Video File Size Number": file.size
            }
          })
        }));
        const airtableData = await airtableResponse.json();

        await logToGrafana(env, "info", "Airtable update submitted", { title });

    // Trigger Rev.ai transcription job and check for success
      const revaiResponse = await env.REVAI.fetch(new Request("https://internal/api/revai/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          media_url: publicUrl,
          metadata: { title, videoType, scheduleDateTime },
          callback_url: "https://callback.gr8r.com/api/revai/callback"
        })
      }));

const revaiText = await revaiResponse.text();

if (!revaiResponse.ok) {
  await logToGrafana(env, "error", "Rev.ai job failed", {
    title,
    revaiStatus: revaiResponse.status,
    revaiResponse: revaiText
  });
  return new Response(JSON.stringify({
    error: "Rev.ai job failed",
    message: revaiText
  }), {
    status: 502,
    headers: { "Content-Type": "application/json" }
  });
}

await logToGrafana(env, "info", "Rev.ai job triggered", { title });


        const responseBody = {
          message: "Video upload complete",
          objectKey,
          publicUrl,
          title,
          scheduleDateTime,
          videoType,
          fileSizeMB: parseFloat((file.size / 1048576).toFixed(2)),
          contentType: file.type,
          airtableData
        };

        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });

      } catch (err) {
        await logToGrafana(env, "error", "Video upload error", { error: err.message });
        return new Response("Error uploading video", { status: 500 });
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
