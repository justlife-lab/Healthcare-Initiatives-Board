/* =====================================================================
 *  config.js — the ONLY file you edit after deploying.
 *  Contains no secrets: an OAuth *client ID* is public by design.
 * ===================================================================== */
window.HIB_CONFIG = {
  // 1) Your Apps Script web-app URL (Deploy ▸ Manage deployments ▸ Web app URL, ends in /exec).
  API_URL: '',

  // 2) Your Google OAuth "Web application" client ID (…apps.googleusercontent.com).
  //    Must be identical to GOOGLE_CLIENT_ID in the Settings tab of the spreadsheet.
  //    Not needed while Settings ▸ AUTH_MODE = test.
  GOOGLE_CLIENT_ID: ''
};
