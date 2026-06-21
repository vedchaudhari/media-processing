# Frontend Build Plan — Video Dashboard

> Plan for wiring the Next.js frontend (`media-processing-website`) to the
> existing `media-processing` backend. **No code is written until this plan is
> approved.**

---

## 1. Goal

Turn the current UI shell into a working **3-screen video dashboard** that
drives the full backend pipeline end-to-end:

1. **Upload** a video (with a real progress bar).
2. **Browse** all videos in a library with live processing-status badges.
3. **Play** a finished video with adaptive-bitrate HLS streaming.

Stay on the existing stack: **Next.js 16 (App Router) + React 19 + Tailwind 4**.

---

## 2. Scope

### In scope
- A typed API client wrapping the 4 backend endpoints + the presigned PUT.
- The full 3-step upload flow with upload progress.
- A library list that polls for status changes.
- A player page using `hls.js`.
- Status badges, loading/empty/error states.
- One small **optional backend change** to expose transcode progress (see §7).

### Out of scope (for now)
- Authentication / login.
- Delete / retry endpoints (backend doesn't support them yet).
- WebSocket/SSE push (we use polling).
- File-type/size validation beyond a basic client check.

---

## 3. Dependencies to add

| Package | Why | Required? |
| --- | --- | --- |
| `hls.js` | Play HLS in browsers that don't support it natively (Chrome/Firefox/Edge). Safari/iOS play natively via `<video>`. | **Yes** |
| `@tanstack/react-query` | Polling, caching, loading/error states for the list + status. Removes a lot of `useEffect` plumbing. | Recommended |

If you'd rather avoid react-query, I'll fall back to a small custom polling
hook. Default plan assumes react-query.

A new env var `NEXT_PUBLIC_API_BASE_URL` (e.g. `http://localhost:3000`) so the
frontend knows where the backend is.

---

## 4. Proposed file structure (frontend `src/`)

```
src/
├── app/
│   ├── layout.tsx                 # (exists) add QueryClient provider + nav
│   ├── page.tsx                   # Library/dashboard (replaces current picker)
│   ├── upload/
│   │   └── page.tsx               # Upload screen (the current picker UI, wired up)
│   └── videos/
│       └── [id]/
│           └── page.tsx           # Player / status page
├── components/
│   ├── UploadDropzone.tsx         # file picker + progress bar (from current page.tsx)
│   ├── VideoCard.tsx              # one item in the library grid
│   ├── StatusBadge.tsx            # colored badge per VideoStatus
│   └── HlsPlayer.tsx              # <video> + hls.js wrapper
├── lib/
│   ├── api.ts                     # typed client for all backend calls
│   ├── types.ts                   # shared types (VideoStatus, VideoListItem, etc.)
│   └── providers.tsx              # react-query QueryClientProvider (client component)
```

---

## 5. The API client (`lib/api.ts`)

Wraps every backend interaction so components never build URLs directly:

```ts
initiateUpload(title): Promise<{ videoId, objectKey, uploadUrl }>
uploadToStorage(uploadUrl, file, onProgress): Promise<void>   // XHR PUT
completeUpload(videoId): Promise<{ videoId, status }>
listVideos(): Promise<VideoListItem[]>                        // {id,title,status}
getPlay(videoId): Promise<{ playbackUrl, status }>            // handles 409
```

- `uploadToStorage` uses **`XMLHttpRequest`** (not `fetch`) so we get
  `upload.onprogress` for a real percentage bar.
- `getPlay` treats a **409** as "not ready yet" (returns the status) rather
  than throwing, so the player page can show a processing state.

---

## 6. Screen-by-screen behavior

### 6.1 Upload screen (`/upload`)
- Reuse the existing dropzone UI (it's already styled well).
- Add a title input (optional; falls back to filename).
- On submit, run the 3-step flow:
  1. `initiateUpload(title)`
  2. `uploadToStorage(uploadUrl, file, onProgress)` → drives a progress bar
  3. `completeUpload(videoId)`
- On success → redirect to `/videos/[id]` (or back to the library).
- Handle errors at each step with a clear message (e.g. presigned URL expired,
  storage upload failed, complete-upload 409).

### 6.2 Library / dashboard (`/`)
- `listVideos()` via react-query with **`refetchInterval` (~3–5s)** so status
  badges advance as the pipeline runs.
- Grid of `VideoCard`s: title + `StatusBadge`.
- `completed` cards link to the player; non-completed show the status and are
  not clickable (or open the status page).
- Empty state ("No videos yet — upload one") and error state.

### 6.3 Player / status page (`/videos/[id]`)
- `getPlay(id)`:
  - If `status !== completed` (409): show a **"Processing…"** panel with the
    current status (and progress %, if §7 is implemented), polling until ready.
  - If `failed`: show a failure message.
  - If `completed`: render `HlsPlayer` pointed at `playbackUrl`.
- `HlsPlayer`: if the browser supports HLS natively (`canPlayType`), set
  `video.src` directly; otherwise attach `hls.js`. Clean up the hls instance on
  unmount.

### 6.4 Status badge colors (proposed)
`uploading/uploaded` → gray · `inspecting/inspected/planning/planned/transcoding`
→ blue (in-progress) · `completed` → green · `failed` → red.

---

## 7. Optional backend change — expose transcode progress

Right now the transcoder computes `job.updateProgress()` but it's **not
persisted**, so the UI can only show the coarse `status`. Two small options:

- **Option A (recommended, minimal):** in `transcoder.worker.ts`, also write a
  `progress` number onto the Video doc as variants complete, and include it in
  `getPlay` / `get-videos`. Gives a real % bar during transcoding.
- **Option B:** leave the backend as-is; the UI shows only status text
  (e.g. "Transcoding…") with an indeterminate spinner.

Default plan: **Option B first** (pure frontend, no backend risk), and I can do
Option A as a follow-up if you want the % bar. Tell me which you prefer.

---

## 8. Configuration / CORS note

- The backend already enables open CORS (`cors()`), so browser calls from the
  Next.js dev origin will work.
- The **presigned PUT to MinIO** also needs CORS to allow the browser origin.
  If the direct upload is blocked by CORS in the browser, we'll need to set a
  CORS rule on the MinIO bucket. I'll verify this during implementation and
  flag it if action is needed (it may require a small MinIO config step).

---

## 9. Build order (so each step is independently testable)

1. Add deps (`hls.js`, react-query) + `NEXT_PUBLIC_API_BASE_URL`.
2. `lib/types.ts` + `lib/api.ts` + `lib/providers.tsx`; add provider to layout.
3. Wire the **upload flow** (highest-value missing piece) on `/upload`.
4. Build the **library** page with polling on `/`.
5. Build the **player** page with `hls.js` on `/videos/[id]`.
6. Polish: status badges, empty/error/loading states, basic nav between pages.
7. (Optional) Backend progress (§7 Option A) if you want a % bar.
8. End-to-end test: upload → watch status advance → play.

---

## 10. Acceptance criteria

- [ ] Can upload a video and watch a real progress bar to 100%.
- [ ] After upload, the video appears in the library and its status advances
      automatically (uploaded → … → completed) without manual refresh.
- [ ] A completed video plays with HLS adaptive streaming in a normal browser.
- [ ] A still-processing video shows a clear processing state, not an error.
- [ ] A failed video shows a clear failure message.

---

## 11. Open questions for you

1. **react-query or a custom polling hook?** (Plan assumes react-query.)
2. **Transcode progress: Option A (backend change, % bar) or Option B
   (frontend-only, status text)?** (Plan assumes B first.)
3. **Routing:** upload on its own `/upload` page with the library at `/`
   (assumed), or keep upload as the landing page?
4. Anything you want explicitly left out or added.
