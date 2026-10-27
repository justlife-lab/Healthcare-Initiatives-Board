/* =====================================================================
 *  config.js — the ONLY file you edit after deploying.
 *  Contains no secrets: an OAuth *client ID* is public by design.
 * ===================================================================== */
window.HIB_CONFIG = {
  // 1) Your Apps Script web-app URL (Deploy ▸ Manage deployments ▸ Web app URL, ends in /exec).
  API_URL: 'https://script.google.com/macros/s/AKfycby78_nW3c9Z9-A3c_In0bW28f88HOHlzkrNB8uUvDI5Z9EBtlyxM99eQwtMzw905G4W/exec',

  // 2) Your Google OAuth "Web application" client ID (…apps.googleusercontent.com).
  //    Must be identical to GOOGLE_CLIENT_ID in the Settings tab of the spreadsheet.
  //    Not needed while Settings ▸ AUTH_MODE = test.
  GOOGLE_CLIENT_ID: ''
};
