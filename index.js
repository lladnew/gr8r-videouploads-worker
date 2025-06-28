// v1.1.3 gr8r-videouploads-worker
// - ADDED: Captures and sends Rev.ai job ID to Airtable ("Transcript ID")
// - ADDED: Sets "Status" field to "Working" in Airtable record
// - RETAINED: All existing fields and behavior from v1.1.2
// v1.1.2 gr8r-videouploads-worker
// - CHANGED: Captures Rev.ai job error response and propagates to Apple Shortcut
// - ADDED: Logs Rev.ai error status and body to Grafana if transcription fails
// v1.1.1 gr8r-videouploads-worker
// - SKIPPED (placeholder for sequencing)
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
        const objectKey = `${prefix}${Date.now()}-${title.replace(/\s+/g, "_")}.${fileExt}`;
        const publicUrl = `https://videos.gr8r.com/${objectKey}`;

        // Upload to R2
        await env.VIDEO_BUCKET.put(objectKey, file.stream(), {
          httpMetadata: { contentType: file.type },
          customMetadata: { title, scheduleDateTime, videoType }
        });

        await logToGrafana(env, "info", "R2 upload successful", { objectKey, title });

        // Trigger Rev.ai transcription job and get job ID
        const revaiResponse = await env.REVAI.fetch(new Request("https://internal/api/revai/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            media_url: publicUrl,
            metadata: title, // only title now
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
              "Video File Size Number": file.size,
              "Transcript ID": revaiJson.id,
              "Status": "Working"

