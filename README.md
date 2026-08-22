# vidOrigin

vidOrigin is a moderator-triggered Reddit Devvit tool for native Reddit images, galleries, and videos. It posts one concise comment linking to temporary reverse-image-search landing pages.

## Feasibility and architecture

This project targets Devvit 0.14.1 and the current `devvit.json`/Devvit Web server architecture. It is server-only: there is no React client, custom post, or webview because a moderator menu action and server endpoint are sufficient. “Bare” is not a current Devvit Web template name. The app slug is `vidorigin` because Devvit requires lowercase app names; the product name shown to people is **vidOrigin**.

```text
Reddit post menu → automatic media detection
  -> Devvit server (moderator check, Reddit API, Redis lock/state)
  -> HTTPS + timestamped HMAC request
  -> Node.js backend
       -> image: highest-quality i.redd.it/preview.redd.it image
       -> gallery: all supported gallery images, subject to configured limits
       -> video: allowlisted v.redd.it download, FFprobe/FFmpeg sampling,
          contrast/black-frame scoring, and dHash deduplication
       -> randomized temporary JPEG assets and provider landing pages
  -> Devvit app-account comment
```

The backend is required because Devvit does not provide FFmpeg or durable process/file-system facilities for this workload. Devvit HTTP fetches have a 30-second limit, so the app uses a 28-second request timeout and the backend caps FFmpeg work. Long, large, slow, or difficult videos fail without a public comment. Devvit external callback endpoints could support longer asynchronous jobs, but they are currently limited-access; this version does not depend on them.

Media is detected without moderator input. Native video uses `Post.secureMedia.redditVideo.fallbackUrl`; a gallery uses valid entries from `Post.gallery`; a single image uses the native Reddit URL in `Post.url`. The backend independently accepts only HTTPS `v.redd.it`, `i.redd.it`, and `preview.redd.it`, validates DNS and redirects, and never accepts a browser-supplied fetch target.

Implemented provider landing pages: Google Lens, SauceNAO, Yandex Images, and TinEye. Each landing page exposes one user-clicked search per image or selected video frame, while the public Reddit comment still contains only one link per provider. These are public consumer URL-search entry points, not claimed APIs; provider behavior can change. Google Images is not listed separately because its old reverse-search flow is now Google Lens. IQDB and Bing Visual Search are not included because they do not currently provide reliable URL-based search links for this workflow. No provider is scraped, no tabs open automatically, and no result is described as definitely original.

## Directory structure

```text
vidOrigin/
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
├── README.md
├── render.yaml
├── backend/
│   ├── .dockerignore
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── auth.test.ts
│       ├── auth.ts
│       ├── config.ts
│       ├── index.ts
│       ├── media.ts
│       ├── pages.ts
│       ├── providers.ts
│       └── store.ts
└── devvit/
    ├── devvit.json
    ├── esbuild.mjs
    ├── package.json
    ├── tsconfig.json
    └── src/server/
        ├── auth.ts
        ├── comment.test.ts
        ├── comment.ts
        ├── media.test.ts
        ├── media.ts
        └── index.ts
```

## Security and privacy

- Requests require an HMAC-SHA256 signature over timestamp, UUID nonce, and exact JSON body. Timestamps have a five-minute window and nonces cannot be replayed in one backend process.
- Only native Reddit hosts are accepted: `v.redd.it` for video and `i.redd.it`/`preview.redd.it` for images. Credentials, ports, private/reserved DNS targets, unexpected content, excess redirects, oversized streams, slow requests, excessive duration, pixel bombs, and oversized galleries are rejected.
- Defaults: 100 MiB, 10 minutes, 20 API requests/minute/IP, two processing jobs, 60-minute session TTL.
- Session IDs contain 256 random bits. Frame names contain 128 random bits. File paths come only from validated identifiers and stored allowlists.
- Source video and downloaded source images are deleted immediately after processing. Video candidate frames are deleted after selection. Search JPEGs plus minimal session metadata (post ID, subreddit, media type, timestamps, random filenames) remain until TTL, then the one-minute cleanup sweep deletes the directory. A crash/restart cleanup also removes abandoned directories. No media is permanently archived.
- Logs redact signatures and source media URLs. They contain event type, post ID, frame count, duration, and sanitized errors. Do not enable debug logging in production unless needed.
- The backend is not an open proxy: the only processing route is authenticated and the only files served must belong to an unexpired stored session.

## Windows prerequisites

Use 64-bit Node.js 22 LTS (Devvit requires Node 22.2.0 or newer). Download the LTS Windows Installer from <https://nodejs.org/en/download>, run it with the default options, then open a **new** PowerShell window.

From any folder:

```powershell
node --version
npm --version
```

Install FFmpeg with Windows Package Manager. From any folder:

```powershell
winget install --id Gyan.FFmpeg -e
```

Close and reopen PowerShell, then from any folder:

```powershell
ffmpeg -version
ffprobe -version
```

If `winget` is unavailable, download the release build linked at <https://ffmpeg.org/download.html>, extract it, and add its `bin` folder to the Windows `Path` environment variable.

## Get and install the project

If this delivered folder is at `C:\path\to\vidOrigin`, open PowerShell and enter:

```powershell
Set-Location 'C:\path\to\vidOrigin'
npm install
npm run check
npm test
npm run build
```

All four commands above run from the **vidOrigin root folder**. `npm install` installs both workspaces. `check` type-checks, `test` runs unit tests, and `build` creates production JavaScript.

## Configure and run the backend locally

Localhost cannot be reached by production Devvit. Local backend startup is still useful for health checks and backend work; use the Render deployment below for end-to-end Devvit testing.

From the **vidOrigin root folder**, create the environment file and a strong secret:

```powershell
Copy-Item '.env.example' 'backend\.env'
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Copy the printed random value. Open `backend\.env` in Notepad from the **vidOrigin root folder**:

```powershell
notepad '.\backend\.env'
```

Set `DEVVIT_SHARED_SECRET` to the random value. For local-only testing set `PUBLIC_BASE_URL=http://localhost:8080`. Save the file.

Start the backend from the **vidOrigin root folder**:

```powershell
npm run dev -w backend
```

Leave that window open. In a second PowerShell window, from any folder:

```powershell
Invoke-RestMethod 'http://localhost:8080/healthz'
```

It should show `ok` as `True`. A direct unauthenticated POST should return HTTP 401; that is expected and proves the API is not public.

Backend logs appear in the backend PowerShell window as JSON. After code changes, the development command restarts automatically. For a production-style restart, press `Ctrl+C`, then from the **vidOrigin root folder** run:

```powershell
npm run build -w backend
npm run start -w backend
```

## Deploy the backend on Render

Render is beginner-friendly, supports Docker, HTTPS, environment variables, logs, and the supplied image installs FFmpeg. A paid always-on web service is recommended: free services may sleep, making Devvit's 30-second fetch limit unreliable. Ephemeral disk is acceptable because all files are intentionally temporary; a restart deletes them early and existing links then expire. No database or persistent disk is required.

1. Create a GitHub repository and push the **vidOrigin root folder**. Never commit `backend/.env`.
2. Sign in at <https://render.com>, choose **New + → Blueprint**, connect the repository, and select `render.yaml`.
3. For `DEVVIT_SHARED_SECRET`, enter the same strong random value used by Devvit. For the first deploy, set `PUBLIC_BASE_URL` to the expected Render URL, such as `https://vidorigin-backend.onrender.com`. If Render assigns a different hostname, update the variable and redeploy.
4. Deploy. Render builds the Docker image, installs FFmpeg, and provides HTTPS automatically.
5. Open `https://YOUR-SERVICE.onrender.com/healthz`. It should return `{"ok":true,...}`.
6. View backend logs in **Render Dashboard → vidorigin-backend → Logs**. Updates are deployed by pushing to the connected branch or choosing **Manual Deploy → Deploy latest commit**.

Cost varies by Render plan and region. Video processing is CPU-intensive; begin with the smallest paid always-on instance, observe processing time/memory, and resize if requests approach 28 seconds. Do not configure autoscaling without a shared replay/lock store; the in-memory nonce replay cache is per process.

## Configure Devvit

Edit `devvit/devvit.json` before upload. Replace `your-public-backend.example.com` with the exact Render hostname only—no `https://` and no path. Devvit submits this external domain for allowlist review; current documentation says review commonly takes one to two business days. Add a Fetch Domains section to the app listing/review README explaining that the hostname is the operator-controlled vidOrigin media-processing API. HTTP fetch apps also need Privacy Policy and Terms links in Developer Settings.

Open PowerShell in the **devvit folder**:

```powershell
Set-Location 'C:\path\to\vidOrigin\devvit'
npx devvit login
npx devvit whoami
```

The login command opens Reddit in a browser. Sign in with the Reddit account that owns the Devvit app and moderates the test subreddit.

The included slug is `vidorigin`. If that slug is already owned by someone else, create the app at <https://developers.reddit.com/new>, choose the server/empty option, and use the initialization code Reddit supplies; then copy these project files into that generated app and change only the required lowercase slug in `devvit.json`. Display text remains vidOrigin.

Set the two global developer settings from the **devvit folder**:

```powershell
npx devvit settings set backend-url
npx devvit settings set backend-secret
```

Enter the full HTTPS backend URL for the first prompt and the exact shared secret for the second. The secret is encrypted and developer-only; it is not committed or exposed to subreddit installers.

## Test in a subreddit

Create a private test subreddit that you moderate and that has fewer than 200 members. From the **devvit folder** run:

```powershell
npx devvit playtest YOUR_TEST_SUBREDDIT
```

`playtest` uploads and installs a prerelease, watches files, and streams Devvit logs. Leave it running. Alternatively, upload and install explicitly from the **devvit folder**:

```powershell
npx devvit upload
npx devvit install YOUR_TEST_SUBREDDIT
```

On Reddit, create three native test posts: one single image, one multi-image gallery, and one video. Wait until Reddit finishes processing uploads. Open each post while signed in as a moderator, open the post's three-dot/Mod Tools menu, and choose **Reverse Source Search**. The app detects the media type automatically. Regular users should not see the action. A successful run shows a toast and creates one comment by the Devvit app account (`u/vidorigin` when that is the registered slug), not by the clicking moderator. The app deliberately uses `runAs: 'APP'`. It does not distinguish/sticky the comment and requests no user-impersonation scope.

Verify that:

1. the comment contains one link for each implemented provider;
2. the subreddit contact text opens `https://www.reddit.com/message/compose?to=/r/YOUR_TEST_SUBREDDIT` (URL-encoded in Markdown);
3. a landing page shows the single image, all accepted gallery images, or 5-7 video frames with user-clicked search buttons;
4. a second trigger reports that a comment already exists;
5. after the TTL, media/page requests show the clean expired message;
6. a link post, YouTube post, or text post produces a moderator toast and no comment.

Devvit logs, from the **devvit folder**:

```powershell
npx devvit logs YOUR_TEST_SUBREDDIT vidorigin --since 30m --verbose
```

During playtest, logs already stream in that PowerShell window. Backend logs are in Render's Logs page or the local backend window.

## Publish and install in production

From the **devvit folder**, after testing:

```powershell
npx devvit publish --bump patch
```

Complete Reddit's review requirements. After approval, moderators install it from the App Directory, or you can update an installation from the **devvit folder**:

```powershell
npx devvit install YOUR_SUBREDDIT
```

Production Devvit cannot call localhost. The backend hostname must exactly match both `backend-url` and the `permissions.http.domains` entry. HTTPS is mandatory.

## Maintenance

From the **vidOrigin root folder**, before every release:

```powershell
npm install
npm run check
npm test
npm run build
npm audit
```

Review dependency updates instead of running `npm audit fix --force` blindly. Update Devvit deliberately from the **devvit folder**, then playtest:

```powershell
npx devvit update app
npx devvit playtest YOUR_TEST_SUBREDDIT
```

For backend changes, push the repository and watch the Render deployment/logs. For Devvit changes, run `publish` again; publishing does not automatically update every existing installation.

## Troubleshooting

- **`node`, `npm`, `ffmpeg`, or `ffprobe` not recognized:** close all PowerShell windows and reopen one. Reinstall or correct the Windows `Path`.
- **Menu item missing:** confirm the app is installed, refresh Reddit, use a moderator account, open the post three-dot menu, and check playtest logs. Mobile clients may need a full restart.
- **“vidOrigin is not configured”:** rerun both `npx devvit settings set` commands from the devvit folder.
- **HTTP/domain error:** the hostname in `devvit.json` must exactly match the backend URL and must be approved in Developer Settings. Do not include protocol/path in `domains`.
- **401 from backend:** the Devvit secret and Render secret differ, or the service clock is badly wrong. Set both to the same value and redeploy.
- **Backend unavailable/timeout:** verify `/healthz`, inspect Render logs, use an always-on instance, and reduce duration/size limits if processing exceeds the Devvit window.
- **Unsupported media:** only native Reddit images, Reddit galleries, and `v.redd.it` video with a completed fallback transcode are supported. External link images and third-party video hosts are rejected.
- **Too large/too long:** adjust the backend environment limits only after considering CPU, memory, and the 30-second Devvit ceiling.
- **FFmpeg failure/no frames:** verify FFmpeg locally; inspect sanitized backend logs. Corrupt, DRM-protected, extremely dark, or unusual-codec media can fail cleanly.
- **Comment creation failure:** the session is still temporary but no success state is written; inspect Devvit logs and retry. The cleanup sweep removes the unused session.
- **Duplicate lock appears stuck:** locks expire after two minutes. Successful-post state intentionally persists to prevent duplicate comments; uninstalling/reinstalling resets installation Redis.

## Future automatic mode

The processing flow is isolated behind one menu endpoint and the backend session API. A future `onPostSubmit` trigger and a subreddit boolean setting can call the same orchestration function. No submission trigger is registered now, and automatic analysis is disabled by design.

## Current official references

- Devvit configuration/schema: <https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_configuration>
- Menu actions: <https://developers.reddit.com/docs/capabilities/client/menu-actions>
- Reddit API and app-account comments: <https://developers.reddit.com/docs/capabilities/server/reddit-api>
- Native `RedditVideo` fields: <https://developers.reddit.com/docs/api/redditapi/models/type-aliases/RedditVideo>
- Reddit `Post.gallery`: <https://developers.reddit.com/docs/api/redditapi/models/classes/Post>
- Reddit `GalleryMedia` fields: <https://developers.reddit.com/docs/api/redditapi/models/type-aliases/GalleryMedia>
- HTTP fetch allowlisting and 30-second timeout: <https://developers.reddit.com/docs/capabilities/http-fetch>
- Redis transactions/concurrency: <https://developers.reddit.com/docs/capabilities/server/redis>
- CLI, playtest, logs, upload, and settings: <https://developers.reddit.com/docs/guides/tools/devvit_cli>
- Launch review: <https://developers.reddit.com/docs/guides/launch/launch-guide>
- TinEye URL-search behavior: <https://help.tineye.com/article/265-tineye-tutorial>

Provider consumer URLs are centralized in `backend/src/providers.ts` so they can be removed or updated quickly if a provider changes its public flow.
