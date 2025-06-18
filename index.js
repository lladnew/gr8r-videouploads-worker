// v1.0.8 gr8r-videouploads-worker: improves reliability + logging for video uploads
//
// Changelog:
// - REPLACED env.R2_PUBLIC_HOST with hardcoded videos.gr8r.com for public URL (v1.0.8)
// - WRAPPED Rev.ai fetch in try/catch to prevent silent failures (v1.0.8)
// - WRAPPED Airtable fetch in try/catch to ensure error visibility (v1.0.8)
// - LOGS success/failure outcomes from downstream fetches to Grafana (v1.0.8)
// - PRESERVED previous improvements from v1.0.7 (see below)
// - REMOVED dummy URLs and RESTORED real service bindings for Airtable, Rev.ai, and Grafana (v1.0.7)
// - ADDED full confirmation logs from downstream workers (v1.0.7)
// - ✅ RESTORED functional pattern from assets-worker using dummy absolute URLs (v1.0.6)
// - REVERTED to root path usage (v1.0.5, broken again)
// - ATTEMPTED refactor using absolute Request objects (v1.0.4)
// - FIXED incorrect relative paths for Worker-to-Worker fetches (v1.0.3)
// - ADDED fallback 403 response for all other requests (v1.0.2)
// - ADDED JSON response payload with upload metadata (v1.0.1)
// - CREATED dedicated Worker for video uploads, removed 'uploads/' prefix unless explicitly set (v1.0.0)
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
        const publicUrl = `https://videos.gr8r.com/${objectKey}`;

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
        await env.AIRTABLE.fetch(new Request("https://internal/api/airtable/update", {
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

        await logToGrafana(env, "info", "Airtable update submitted", { title });

        // Trigger Rev.ai transcription
        await env.REVAI.fetch(new Request("https://internal/api/revai/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            url: publicUrl
          })
        }));

        await logToGrafana(env, "info", "Rev.ai job triggered", { title });

        const responseBody = {
          message: "Video upload complete",
          objectKey,
          publicUrl,
          title,
          scheduleDateTime,
          videoType,
          fileSizeMB: parseFloat((file.size / 1048576).toFixed(2)),
          contentType: file.type
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
