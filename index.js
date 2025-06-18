// v1.0.0 gr8r-videouploads-worker: handles video uploads
//
// Changelog:
// - CREATED dedicated Worker for video uploads
// - REMOVED 'uploads/' prefix from R2 key unless explicitly set via query param
// - UPLOADS video to R2, updates Airtable, triggers Rev.ai job
// - LOGS all major steps to Grafana using worker bindings
// - REMOVED all hardcoded URLs in favor of service bindings

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
        const scheduleDateTime = formData.get("scheduleDateTime");
        const videoType = formData.get("videoType");

        if (!(file && title && scheduleDateTime && videoType)) {
          return new Response("Missing required fields", { status: 400 });
        }

        const fileExt = (file.name || 'upload.mov').split('.').pop();
        const prefix = searchParams.get("prefix") || "";
        const objectKey = `${prefix}${Date.now()}-${title.replace(/\s+/g, "_")}.${fileExt}`;

        // Upload to R2
        await env.VIDEO_BUCKET.put(objectKey, file.stream(), {
          httpMetadata: { contentType: file.type },
          customMetadata: {
            title,
            scheduleDateTime,
            videoType
          }
        });

        await logToGrafana(env, "info", "R2 upload successful", { objectKey, title });

        // Update Airtable
        await env.AIRTABLE.fetch("/api/airtable/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            table: "Video posts",
            title,
            fields: {
              "Video URL": `https://${env.R2_PUBLIC_HOST}/${objectKey}`,
              "Schedule Date-Time": scheduleDateTime,
              "Video Type": videoType,
              "Video Filename": `${title}.${fileExt}`,
              "Content Type": file.type,
              "Video File Size": `${(file.size / 1048576).toFixed(2)} MB`,
              "Video File Size Number": file.size
            }
          })
        });

        await logToGrafana(env, "info", "Airtable update submitted", { title });

        // Trigger Rev.ai transcription
        await env.REVAI.fetch("/api/revai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            url: `https://${env.R2_PUBLIC_HOST}/${objectKey}`
          })
        });

        await logToGrafana(env, "info", "Rev.ai job triggered", { title });

        return new Response("Video upload complete", { status: 200 });

      } catch (err) {
        await logToGrafana(env, "error", "Video upload error", { error: err.message });
        return new Response("Error uploading video", { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function logToGrafana(env, level, message, meta = {}) {
  try {
    await env.GRAFANA.fetch("/api/grafana", {
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
    });
  } catch (err) {
    console.error("Grafana logging failed", err);
  }
}
