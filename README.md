// v1.3.0 gr8r-videouploads-worker
// CHANGED: Switched from multipart/form-data to application/json for POST payload
// REMOVED: All R2 upload logic and SHA-1 file hash generation (upload now done prior to Worker call)
// ADDED: Accepts filename (e.g. `xyz.mov`) and constructs R2 public URL internally
// ADDED: Validates file exists in R2 before proceeding, logs error and aborts if not found
// ADDED: Attempts to read customMetadata (e.g. file size, content type) from R2 to populate Airtable
// RETAINED: All Airtable update logic, Rev.ai job submission, and Grafana logging structure
// RETAINED: Response format returned to Apple Shortcut

// v1.2.1 gr8r-videouploads-worker
// changing logging because clone made it hit max cloudflare size error 413 
// v1.2.0 gr8r-videouploads-worker
// skipped several versions from rollback now adding verbose console logging at top line 45 to 64
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
// - ADDED full confirmation logs// v1.0.0 gr8r-videouploads-worker: handles video uploads
//
// Changelog:
// - CREATED dedicated Worker for video uploads
// - REMOVED 'uploads/' prefix from R2 key unless explicitly set via query param
// - UPLOADS video to R2, updates Airtable, triggers Rev.ai job
// - LOGS all major steps to Grafana with verbose error handling
