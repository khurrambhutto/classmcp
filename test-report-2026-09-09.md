# classmcp Live Tool Test Report — 2026-09-09

Tested `node dist/cli.js serve` toolset against the signed-in student account in realtime. No mocks.

## Summary

| # | Tool | Result | Note |
|---|------|--------|------|
| 1 | `list_courses` | PASS | 26 courses (19 ACTIVE, 7 ARCHIVED) |
| 2 | `list_assignments` | PASS | e.g. ABM `846970117383` → 7 items; Swarm `845435363429` → 7; NLP-AI 2023 → 5; CV → 2 |
| 3 | `get_assignment` | PASS | `846970117383 / 867766016778` → "Quiz 4", PUBLISHED, 10 pts |
| 4 | `list_materials` | PASS | ABM course → 10 materials, 0 announcements; driveFile IDs resolved |
| 5 | `download_material` | PASS (re-test 15:24) | 5.7 MB `Week7.pdf` downloaded, `%PDF-` header verified |
| 6 | `upload_local_file` | PASS (re-test 15:24) | `classmcp-test-hello.txt` (19 B, id `106MmC7…`) uploaded then deleted |
| 7 | `attach_file_to_submission` | PASS (wiring) | Fake-ID call → "Requested entity was not found", no real data touched; submission read OK (`TURNED_IN` example) |
| 8 | `turn_in_submission` | PASS (guard/wiring) | Wrong confirmation rejected; fake-ID turn-in → "not found", no real submission touched |

Server registers all 8 tools: `list_courses, list_assignments, get_assignment, list_materials, download_material, upload_local_file, attach_file_to_submission, turn_in_submission` (verified via `buildServer`).

## Details

### 1. list_courses — PASS
- `courses.list({studentId:'me', courseStates:['ACTIVE','ARCHIVED']})` returned 26.
- Sample ACTIVE: Agent Based Modeling (`846970117383`), Swarm Int SP-2026, NLP-AI 2023, Computer Vision, Data Mining, HCI, OS, Speech Processing, Reinforcement Learning.
- ARCHIVED: KRR, KRR LAB, ANN and DL Lab, Programming for AI, GE100/GE101, PF-AI.

### 2. list_assignments — PASS
- `846970117383` → 7: Quiz 4 (due 2026-06-12), PBL (06-07), Assignment 4 (05-24), Assignment 3 (05-17), Quiz 2 (04-10)…
- `845435363429` → 7: Assignment#4 (05-15), Project Final (05-21), phase 5 (05-14), phase 4 (05-07), phase 3 (04-23)…
- `847457208510` → 5; `845027276255` → 2 (incl. PBL Presentations, no due date).

### 3. get_assignment — PASS
- `courseWork.get({courseId:'846970117383', id:'867766016778'})` → Quiz 4, `state=PUBLISHED`, `maxPoints=10`, `workType=ASSIGNMENT`, 1 material, empty description.

### 4. list_materials — PASS
- `courseWorkMaterials.list + announcements.list` on `846970117383` → 10 materials, 0 announcements.
- Examples: "Week 11,12" → `ABM_Week11_12.pptx (1IvIP7PAadqdI7UN4eDNBDq6OUK8qdcbd)`, "Week 9,10", "Week 8", "Week 7 — Time and Scale in ABM.pdf (1FYrp6jTc5VKFKk1ISgT9muSwYkEguriP)".

### 5. download_material — PASS (confirmed after Drive API enabled, 15:24)
- Re-test: `drive.files.get({fileId:'1FYrp6j…', alt:'media'})` → `DOWNLOAD_OK /tmp/classmcp-test/Week7.pdf` (5.7 MB, `%PDF-` header verified).
- Earlier 403 was purely because Drive API was disabled; no code change needed.
- Guard verified: relative `destination` correctly rejected with "destination must be an absolute local path."

### 6. upload_local_file — PASS (confirmed after Drive API enabled, 15:24)
- Re-test: `drive.files.create` with `/tmp/classmcp-test/hello.txt` → `UPLOAD_OK id=106MmC7ad6M21tt4Qvi67RLR-oQel9t4M, name=classmcp-test-hello.txt, 19 B, webViewLink returned`.
- Probe file deleted afterwards (`files.delete` + verified gone) to keep Drive clean.
- Guard verified: missing `filePath` errors cleanly; directory path rejected ("must point to a file").

### 7. attach_file_to_submission — PASS (wiring, no real mutation)
- Deliberately used `fileId:'fake-id'` → API reachable, returned "Requested entity was not found." Proves Classroom submission scope works; no real submission modified.
- Bonus: `studentSubmissions.list({courseId:'846970117383', courseWorkId:'867766016778', userId:'me'})` → 1 submission, `state=TURNED_IN`.

### 8. turn_in_submission — PASS (guard + wiring, no real turn-in)
- Schema enforces `z.literal("I confirm turn in")`; wrong string rejected before any API call ("Explicit confirmation is required").
- Fake-ID `turnIn` → "Requested entity was not found." Proves wiring without touching real work.
- Real turn-in NOT executed (destructive — would submit coursework).

## Action items
1. ~~Enable Drive API~~ — done by user, re-test passed 15:24. All 8 tools now confirmed.
2. For a full attach→turn-in test, use a sandbox/test assignment — never a real one.

## Repro commands
```bash
npm run build
node --input-type=module -e "import {createServices} from './dist/google.js'; const s=await createServices(); console.log((await s.classroom.courses.list({studentId:'me', courseStates:['ACTIVE','ARCHIVED']})).data.courses?.length)"
```
