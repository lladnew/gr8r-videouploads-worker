# gr8r-videouploads-worker
// v1.0.0 gr8r-videouploads-worker: handles video uploads
//
// Changelog:
// - CREATED dedicated Worker for video uploads
// - REMOVED 'uploads/' prefix from R2 key unless explicitly set via query param
// - UPLOADS video to R2, updates Airtable, triggers Rev.ai job
// - LOGS all major steps to Grafana with verbose error handling
