# Healthcare Initiatives Board

Enterprise task, initiative and collaboration board for **Justlife Healthcare**.
Frontend on **GitHub Pages** · backend in **Google Apps Script** · database in **Google Sheets**.

```
Browser (GitHub Pages)  ──text/plain POST──▶  Apps Script web app (Code.gs)  ──▶  Google Sheet
  index.html / app.js                         • verifies Google sign-in              Tasks, Comments, …
  config.js (URL + client ID)                 • permissions, validation, locking
```

## Files

| File | Purpose |
|---|---|
| `index.html` | App shell (login, sidebar, top bar, drawer, icon set). |
| `style.css` | Navy / white / grey design system, responsive layouts. |
| `app.js` | All frontend logic: views, forms, threaded comments, sync, bulk import. |
| `logo.png` | Justlife logo (sidebar, sign-in page, browser tab icon). |
| `config.js` | **The only file you edit**: Apps Script URL + Google client ID. No secrets. |
| `Code.gs` | Apps Script backend: API, auth, validation, setup, notifications. |
| `appsscript.json` | Apps Script manifest (V8, web-app settings). |
| `tests/` | 38 automated backend tests (`node tests/backend.test.js`) + an Apps Script simulator used only by the tests. Not needed on GitHub. |
| `.nojekyll` | Tells GitHub Pages to serve every file as-is. |

> **Why one `app.js`?** No build step and no frameworks, so you can upload it to GitHub as it is and it will keep working.
> It is organised into clearly marked sections (state, API, views, drawer, forms, events).

---

## 1. Team roster & task ownership

Setup adds your two teams to the **Users** tab (names and team only, no job titles), all as **Member**:

| Team | People |
|---|---|
| **BD** | Nitish, Nazar, Sravanthi, Sohaib, Sandeep, Swapnil |
| **Marketing** | Yana, Bilge, Ameya, Yuvraj, Saloni, Rabin, Rupa |

- Sohaib uses `sohaib.saqib@justlife.com`. Everyone else has a **placeholder email** `firstname@justlife.com`.
  Correct them in the app: **Settings ▸ Users & roles ▸ Edit ▸ change the email**. This updates every task, comment,
  notification and log row that uses the old address. You can also run `renameUserEmail('old@…','new@…')` in Apps Script.
  Fix the emails before switching to Google sign-in, because people sign in with their real Google address.
- **TBD:** a task can be left unassigned. It shows as **TBD** and appears in the red *TBD* chip of its team.
- **All tasks** has the same owner chips as the old board (`BD · All | Nitish | … | TBD`, `Marketing · All | …`).
  Click a chip to filter, and click it again to clear. Counts are open tasks.
- Teams come from Settings → `DEPARTMENTS` (`BD, Marketing`). Add a team there and it gets its own chip row.

### Adding new team members
**Sandeep** is set up as a **Manager**. Managers (and Admins) can open **Team overview ▸ Add team member**
(or **Settings ▸ Team members**) and create a profile: email, name, team, role (Member or Viewer).
The new person can sign in straight away with that email and sees their own name, tasks and notifications.
Managers can't create Admins or Managers and can't edit them. Only Admins can.

### Tagging people in discussions
In any comment or reply, type **@**. A list of teammates appears (filtered as you type). Pick one with
the mouse, ↑/↓ + Enter, or Tab. The name is inserted as **@Name**, highlighted in the conversation, and that person gets a
**MENTION** notification that opens the discussion. Tagging also works when editing a comment (only newly tagged people are notified).

### Importing existing tasks
**Settings ▸ Import tasks** (Admins and Managers): copy rows from Excel, Google Sheets or the old board, including a header row, and paste them in.
Click **Preview** to see exactly how each row maps (owner → person, status, due date, warnings). Then click **Import**.
- Owners are matched by name or email. Blank, "TBD" or unknown owners → TBD.
- Status words like *Live, Build, Under design, Parked, Done* are translated. Dates may be `2026-11-15`, `15/11/2026` or `15 Nov 2026`.
- Rows without a due date get today + 14 days (shown in the preview). Unknown initiative names are created.
- Re-importing is safe: the same title for the same owner is skipped.
- Each assignee gets one notification per import.

## 2. Set up the Google Sheet + Apps Script (≈10 min)

1. Open the spreadsheet → **Extensions ▸ Apps Script**.
2. Delete the default `Code.gs` content and paste the full contents of **`Code.gs`**.
   `CONFIG.SPREADSHEET_ID` is already set to your sheet (`1C-GvByP0iXhlK12fCP51x0KKjFKkNsxLl39Z66CkyNM`).
3. *(Optional)* ⚙ **Project Settings ▸ Show "appsscript.json"**, then paste **`appsscript.json`**.
4. Select the function **`setupHealthcareBoard`** in the toolbar and click **Run**.
   - Google asks for permission: **Review permissions ▸ choose your account ▸ Advanced ▸ Go to project ▸ Allow**.
     Scopes requested: spreadsheets (read/write your sheet), external requests (verify Google sign-in tokens),
     triggers (daily deadline reminders).
   - The execution log prints a report. Setup:
     - creates **Tasks, Initiatives, Projects, Users, Comments, ActivityLog, Notifications, Settings** and a **_Guide** tab,
     - adds headers, notes on every header cell, text/date formats, frozen header rows, filters and tab colours,
     - adds default **Settings** (never overwrites values you've changed),
     - makes **you** the first **Admin** in Users,
     - installs a daily trigger for `runDeadlineScan` (due-soon/overdue notifications).
   - It is **safe to run again**. It only adds what's missing. Your existing `Sheet1` is left untouched.
     If a tab with the same name already contains different data, setup stops and asks you to rename it.
     It never overwrites or deletes anything.
5. *(Optional test data)* Run **`loadSampleData`**. Every sample row is prefixed **[SAMPLE]**. Run
   **`removeSampleData`** to delete exactly those rows again.
6. **Deploy ▸ New deployment ▸ ⚙ Web app**
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**  ← required (see "Security" below for why this is safe)
   - **Deploy**, then copy the **Web app URL** (ends in `/exec`).
7. Paste the URL into **`config.js` → `API_URL`**.

> After any later change to `Code.gs`: **Deploy ▸ Manage deployments ▸ ✏ Edit ▸ Version: New version ▸ Deploy**.
> This keeps the same URL. Creating a *new* deployment would give you a different URL.

## 3. Sign-in: testing first, then Google

### Phase A — test sign-in (no Google Cloud setup)
In the **Settings** tab set `AUTH_MODE` = **`test`**. Users type an email that must exist (Active) in the
**Users** tab. A yellow banner warns that identities are **not verified**: anyone who knows a listed email
could sign in as that person. Use this only while testing.

Add your team in the app (**Settings ▸ Users & roles ▸ Add user**) or directly in the Users tab.

### Phase B — secure Google sign-in (do this before real use)
1. Go to <https://console.cloud.google.com/> → create or select a project.
2. **APIs & Services ▸ OAuth consent screen**: User type **Internal** (Google Workspace, so only justlife.com accounts can sign in).
   Fill in the app name and support email. Scopes: none beyond the defaults (`openid`, `email`, `profile`).
3. **APIs & Services ▸ Credentials ▸ Create credentials ▸ OAuth client ID ▸ Web application**
   - *Authorised JavaScript origins:* `https://<your-github-username>.github.io`
     (plus `http://localhost:8000` if you test locally). Use the origin only, with no path and no trailing slash.
   - *Authorised redirect URIs:* leave empty.
4. Copy the **Client ID** (`…apps.googleusercontent.com`). It is public by design. There is **no client secret** in this setup.
5. Paste it in **two places**:
   - `config.js` → `GOOGLE_CLIENT_ID`
   - Spreadsheet **Settings** tab → `GOOGLE_CLIENT_ID`
6. Settings tab → `AUTH_MODE` = **`google`**, `ALLOWED_DOMAINS` = `justlife.com`.
   - `AUTO_PROVISION = TRUE`: anyone with a verified @justlife.com Google account is added as `DEFAULT_ROLE` (Member) on first sign-in.
   - `AUTO_PROVISION = FALSE`: only people you list in Users can sign in.

**How it's verified:** Google Identity Services gives the browser a signed ID token (JWT). `Code.gs` sends it
to `https://oauth2.googleapis.com/tokeninfo` and checks `aud` = your client ID, the issuer, `email_verified`
and expiry. It then checks the Users list / allowed domain. Only then does it issue a random session
token (CacheService, max 6 h). Every API call is re-authorised server-side against the Users tab, so
emails, roles and IDs sent by the browser are never trusted.

## 4. Publish on GitHub Pages

1. Create a repository (e.g. `healthcare-initiatives-board`). The free GitHub plan needs a **public** repo for Pages.
   That's fine, because the repo contains no secrets and no data. The data stays in your private Sheet.
2. Upload: `index.html`, `style.css`, `app.js`, `config.js`, `logo.png`, `.nojekyll`
   (plus `README.md`, `Code.gs`, `appsscript.json`, `tests/` if you like. The website doesn't need them).
3. **Settings ▸ Pages ▸ Build and deployment ▸ Deploy from a branch ▸ `main` / root ▸ Save**.
4. After about a minute the site is live at `https://<username>.github.io/<repo>/`.
5. If you change `config.js` later, commit it. Pages redeploys automatically (hard-refresh with Ctrl+Shift+R).

## 5. Roles & permissions (enforced in Code.gs)

| Action | Admin | Manager | Member | Viewer |
|---|:-:|:-:|:-:|:-:|
| View everything, comment, reply | ✓ | ✓ | ✓ | ✓ |
| Create / duplicate tasks | ✓ | ✓ | ✓ | – |
| Edit a task | all | all | if creator, assignee or collaborator | – |
| Archive a task | all | all | if creator | – |
| Create / edit initiatives & projects | ✓ | ✓ | edit if owner | – |
| Edit / delete own comments | ✓ | ✓ | ✓ | ✓ |
| Delete others' comments (moderation) | ✓ | – | – | – |
| Users & configuration | ✓ | – | – | – |

## 6. How synchronisation works (honest version)

Updates are **not instant push**. Apps Script can't hold open connections, so the board uses polling:
- Every save goes straight to Google Sheets. The UI shows *Saving…*, then a success or error toast.
- Every open browser checks for changes every **`POLL_SECONDS`** (default 30 s) while the tab is visible,
  and immediately when you come back to the tab or after you save something.
  The check is cheap: the server compares a revision stamp and only returns data if something changed.
- **No silent overwrites:** every record has a `Version`. If someone else saved first, the server rejects your
  save (`CONFLICT`) and the app asks you to *apply your changes on top* or *discard yours*.
- Writes run inside `LockService`, so IDs (`TSK-00001`, `CMT-00001`, …) are unique and never row numbers.
- Comments submitted twice (double-click, flaky network) within 10 s are de-duplicated.

## 7. Google Sheets schema

Full column documentation is generated in the **_Guide** tab and in a note on every header cell.

| Tab | Key | Columns |
|---|---|---|
| **Tasks** | TaskID | TaskID, Title, Description, InitiativeID, ProjectID, Category, Team, CreatedBy, AssignedTo (blank = TBD), Collaborators, Priority, Status, StartDate, DueDate, CompletedDate, Progress, DependsOn, Links, Archived, CreatedAt, UpdatedAt, UpdatedBy, Version |
| **Initiatives** | InitiativeID | InitiativeID, Name, Description, Objective, Owner, Members, Priority, Stage, Category, Forum, NeedleMover, WeeklyFocus, RedFlag, StartDate, TargetDate, Milestones, Risks, Archived, CreatedAt, CreatedBy, UpdatedAt, UpdatedBy, Version |
| **Projects** | ProjectID | ProjectID, Name, Description, InitiativeID, Owner, Status, StartDate, TargetDate, Archived, CreatedAt, CreatedBy, UpdatedAt, UpdatedBy, Version |
| **Users** | Email | Email, Name, Role, Department, Title, Active, CreatedAt, LastLogin |
| **Comments** | CommentID | CommentID, TaskID, ParentID (blank = top-level), Body, AuthorEmail, AuthorName, CreatedAt, UpdatedAt, Status (active/edited/deleted) |
| **ActivityLog** | LogID | LogID, Timestamp, ActorEmail, ActorName, EntityType, EntityID, Action, Details |
| **Notifications** | NotificationID | NotificationID, Recipient, Type, EntityType, EntityID, Message, Actor, CreatedAt, Read, DedupeKey |
| **Settings** | Key | Key, Value, Description |

- Dates are stored as text `yyyy-MM-dd`. Timestamps are ISO-8601 UTC. "Today" uses Settings → `TIMEZONE` (Asia/Dubai).
- Text that starts with `=` or `+` is stored as plain text (no formula injection).
- **Initiative / project progress** = average progress of linked tasks, excluding archived and cancelled tasks
  (Completed counts as 100 %). It is never typed in by hand.
- Initiative **stages** follow your existing board: Under Design → Build → Live, plus Parked and Completed. Caps come
  from `STAGE_CAPS` (default 8 each). Going over a cap asks for confirmation.

## 8. Security notes

- **Why "Anyone" access is safe here:** the web app URL alone gives nothing. Every action except `ping`/`config`
  needs a server-issued session, which is created only after Google verifies the ID token, or in test mode after
  the email is matched against the Users tab. The spreadsheet itself stays private to you, and the script runs as you.
  "Anyone with Google account" would make Google redirect the browser to a login page, which breaks the
  cross-origin call from GitHub Pages.
- No credentials, secrets or service-account keys exist anywhere in the repo.
- `AUTH_MODE` and `GOOGLE_CLIENT_ID` can only be changed in the sheet, not from the web app.
- Inputs are validated and length-limited server-side. All output is HTML-escaped. Only http(s) links are rendered.
- Treat the board as operational data: **do not record patient information** (the UI reminds users).
- Optional: run `backupSpreadsheet()` to make a dated copy of the whole spreadsheet in your Drive.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| "Cannot reach the board backend" | Check `API_URL` ends in `/exec` and the deployment access is **Anyone**. Open the URL in a browser: it should show `{"ok":true,…}`. |
| "The server returned a web page instead of data" | Deployment access is not "Anyone", or you used a `/dev` URL. Redeploy as described in 2.6. |
| Changes to Code.gs not taking effect | Deploy ▸ Manage deployments ▸ Edit ▸ **New version**. |
| "Run setupHealthcareBoard()" message | Setup hasn't been run, or a tab was renamed. Run setup again (safe). |
| Google button missing / "origin not allowed" | Add the exact GitHub Pages origin to *Authorised JavaScript origins*. Wait 5 min. Hard-refresh. |
| "Sign-in token was issued for a different application" | `GOOGLE_CLIENT_ID` in config.js and in the Settings tab differ. |
| "…is not authorised to use this board" | Add the user in Users (Active = TRUE), or add their domain to `ALLOWED_DOMAINS` with `AUTO_PROVISION = TRUE`. |
| Session expired | Normal after `SESSION_HOURS`. Sign in again. |
| "The board is busy" | Several people saved at the same moment. The app retries once automatically. Try again. |
| No due-soon / overdue notifications | Check Apps Script ▸ Triggers for `runDeadlineScan`, or re-run setup. |
| "Setup needed: paste your Apps Script web-app URL" | `API_URL` is empty in the deployed `config.js`. |
| A teammate can't sign in with Google | Their email in Users is still the placeholder. Edit it in Settings ▸ Users. |

## 10. Testing checklist

**Automated, already executed during the build** (`node tests/backend.test.js` + headless-browser runs):

- [x] 1. Setup creates all sheets, headers, filters, settings, the first admin and the trigger
- [x] 2. Existing data preserved (Sheet1 untouched; older Tasks tab gets new columns, rows intact; conflicting tab → setup stops)
- [x] 3. Authorised user signs in (test mode) · [x] 4. Unauthorised email rejected; forged/missing session rejected
- [x] 5. Create task → row written in Tasks with a generated ID
- [x] 6. Edit updates the same row (no duplicates), Version increments
- [x] 7. Second user sees the change (sync revision check + second browser session)
- [x] 8–10. Comment, reply from another user, replies linked to the right task and parent; cross-task replies rejected
- [x] Only authors edit their comments; admins can delete; double submissions ignored
- [x] 11. Dashboard KPIs/charts computed from records; KPI drill-down opens the matching tasks
- [x] 12. Filters, search (global + table), sorting, pagination
- [x] 13. Overdue detection; daily scan creates overdue / due-soon notifications once (de-duplicated)
- [x] 14. Stale edit rejected → conflict dialog → "apply my changes" keeps the other user's edit
- [x] 15. Server errors show clear messages (validation, permissions, network)
- [x] 16. Desktop 1440 px and mobile 390 px layouts (no horizontal scroll)
- [x] 17. Cross-origin `fetch` from a different origin with **zero CORS pre-flights** (simulated Apps Script origin)
- [x] Kanban drag-and-drop saves the new status
- [x] Team roster seeded once (re-running setup adds no duplicates); TBD tasks; owner chips filter by team / person / TBD
- [x] Bulk import: preview, owner matching, status/date translation, initiative creation, duplicate skipping
- [x] Changing a user's email updates every sheet; the old session stops working
- [x] @mention picker inserts names; tagged people get one MENTION notification
- [x] Sandeep (Manager) adds a team member, who can then sign in with their own name; managers cannot create admins

**Needs manual verification in your environment** (can't be done without your Google account):

- [ ] Run `setupHealthcareBoard()` on the real spreadsheet and review the report
- [ ] Replace placeholder emails with real ones (Settings ▸ Users)
- [ ] Import the existing tasks from the old board (Settings ▸ Import tasks)
- [ ] Deployed web app URL returns `{"ok":true…}` and the GitHub Pages site connects to it
- [ ] Google sign-in with a justlife.com account (after Phase B); a non-company Gmail is refused
- [ ] Two colleagues on different computers: create/edit/comment and see each other's changes within `POLL_SECONDS`
- [ ] Daily trigger fires (`runDeadlineScan` appears under Apps Script ▸ Executions the next morning)
- [ ] Switch `AUTH_MODE` from `test` to `google` before announcing the board to the team

## 11. Limits worth knowing

- Apps Script quotas (Workspace): about 30 simultaneous executions, and every request takes about 0.5–2 s. That's fine for a team of
  dozens and a few thousand tasks. All tasks are loaded once and then filtered and paged in the browser. Past roughly 10k tasks,
  archive old ones into a separate spreadsheet.
- Notifications are in-app only. Email alerts can be added later in `notify_()` with `MailApp`.
- "New comment" highlighting is remembered per browser. The comments themselves always come from Google Sheets.
