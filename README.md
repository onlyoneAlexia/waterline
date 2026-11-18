# Waterline

**See a flood against the things you own.** Snap a photo of your car, bike or front door. Aholo Lux3D turns it into a true-scale 3D model, and Waterline places it on your real street in a photorealistic 3D city. Then you raise the water.

Flood maps show risk as a blue patch, and people underestimate it. Waterline shows the water reaching *your* car's windows on *your* street.

Built for the Manycore Aholo Global 3D AI Hackathon (2026).

## How Lux3D is used

| Step | Lux3D feature |
|---|---|
| Photo of your object → 3D model | Image-to-3D (`G1-Turbo`, PBR materials, AI size prediction) |
| "Describe it" → 3D model | Text-to-3D (photorealistic style) |
| Real-world scale | You pick what it is (car 1.5 m, SUV 1.8 m, bus 3.2 m…). Photo models also come back in Lux3D's estimated metres (`aiPredictSize`), used for "Other". Text models come back scaled into a 10-unit box, so they always need a height. |

The map is CesiumJS with Google Photorealistic 3D Tiles. The flood is a flat water level ("bathtub" model) measured from the street at your pin.

## Inside your home (Aholo World)

The street shows the water outside. **Inside** shows it coming in. Aholo World turns one photo of a room (or a description) into a 3D room made of Gaussian splats. Waterline shows the room with three.js and Spark, scales it to the ceiling height you give (a room rebuilt from one photo has no true size of its own), and floods it with the same water level as the street, minus how far your floor sits above the street. Everything below the waterline is tinted, and a panel says what that depth means indoors (sockets, furniture, when to go upstairs).

- An example living room (built by Aholo World from a short description) ships with the app, so anyone can try it at once.
- Building your own room takes about 10 minutes. If the page is closed, it keeps waiting for the room next time.
- Server: `POST /api/world` (photo and/or description → `worldId`), `GET /api/world?id=` (status; the finished `.spz` is saved under `public/models/worlds/`).

## Beyond the picture: real risk and a way out

- **Real flood risk.** When you set your spot, Waterline looks up modelled river-flood depths there (10% down to 0.2% chance each year) from the JRC / Copernicus *Global river flood hazard maps* v2.1, and lets you show them on your street. The app says plainly when the model shows nothing: it leaves out flash floods from rain and coastal floods, the kind that killed people in Kerrville, Texas (2025) and Valencia, Spain (2024).
- **Get to higher ground.** For the current water level, Waterline searches bare-earth terrain (Cesium World Terrain) outward from your spot for the nearest ground at least 1 m above the water, gets a walking route there (OSRM on OpenStreetMap, via FOSSGIS), and tells you how far it is, how long it takes on foot, and how deep the water on the way would be. If there is no higher ground within 3 km, it says to go up to the upper floors of a strong building instead.

## Setup

You need Node.js 22.9 or newer. Run `npm ci` once. Cesium is installed and served locally; geotiff reads the flood maps.

**No-key demo:** run `npm start` and open http://localhost:3000/?mode=studio. Studio starts with the existing Lux3D-generated Family SUV, a detailed illustrative street, synthetic hillside and animated water. No map account or new generation credits are needed. Studio is not a reconstruction of a real location. When a Cesium token is configured, the root URL opens Real street by default; the mode picker always lets you choose.

For live maps and new generation, configure the optional services below:

1. **Lux3D API key**: https://labs.aholo.ai/api-keys
2. **Cesium ion token**: sign up free at https://ion.cesium.com, copy a token from *Access Tokens*, and in *Asset Depot* add **Google Photorealistic 3D Tiles** to your assets.
3. Copy `.env.example` to `.env` and paste both keys in.
4. Run:

   ```
   npm start
   ```

   Open http://localhost:3000.

## Using it

1. Start in Studio, or select **Real street** (needs map credentials) and type your street, town or postcode in **Your spot**, or press **Use my location**. The spot and depth gauge are set on the street there; click the map to fine-tune it.
2. Optional: open **Inside** to see the water come into a room (the example room, or one built from your photo).
3. Add objects: upload a photo, describe one, or pick from the Library. When a model is ready, click the map to place it. Adjust its height and direction in the list.
4. Drag the slider or press **Play the flood**.
5. **Orbit camera** for a video shot; **Copy share link** saves the scene in a URL. **Save scene/Open scene** round-trip a validated JSON file; **Save 3D image** exports a labelled PNG.
6. Use **Street view**, **Overview** or **Focus object** to reframe the camera. **Cinema view** hides the panel for recording; press Esc to bring it back. The flood button pauses an active animation.

The Studio street uses batched static geometry, pitched roofs, window/door details, front gardens, curbs, drains, crossings, lamps, soft shadows and locally bundled CC0 photo/normal textures from Poly Haven. Texture provenance and hashes are in `public/textures/sources.json`. Camera orbit and water motion use elapsed time, and the facts list is reused during animation to reduce UI churn. The street is an illustrative environment, not a fluid simulation or a claim of photorealistic reconstruction.

## Ready-made Library models

Generate models once and ship them with the app (good for the public demo and for anyone without credits):

```
npm run generate -- --image photos/car.jpg --name "Family car" --height 1.5
npm run generate -- --prompt "a red city bus" --name "City bus" --height 3.2
```

Each run saves `public/models/library/<name>.glb` and adds it to `public/models/library.json` with its provenance: the Lux3D task id, the prompt or a copy of the source photo (in `public/models/sources/`), the file size and SHA-256. For a photo you didn't take, add `--source-url`, `--credit` and `--license`.

Then run `npm run optimise`. Lux3D returns 2048 px PNG textures, which are most of each 9–17 MB file; this re-encodes them as JPEG without touching the geometry (the six shipped models went from 67 MB to 24 MB in total). The original downloads are kept in `.waterline/original-models/`, and `library.json` records both the original and the shipped SHA-256.

The shipped Library has six Lux3D models: Family SUV, Small car, Scooter, Adult person, Wheelie bin and Front door. The car and scooter were made from CC0 photos (credits in `THIRD_PARTY_NOTICES.txt`); the others came from text prompts.

## Project layout

```
server.mjs              web server + private Lux3D proxy (key never reaches the browser)
lib/lux3d.mjs           Lux3D OpenAPI client: upload, create task, poll, download
lib/flood-depth.mjs     reads JRC flood-depth GeoTIFFs with HTTP range requests
scripts/generate.mjs    CLI to add Library models
public/app.js           map, water, models, sharing, place search
public/room.js          "Inside your home": Aholo World room viewer (three.js + Spark, loaded on demand)
public/vendor/          three.js and Spark, bundled locally (MIT)
public/glb-measure.js   reads a GLB's bounding box to place it at true scale
test/                   node --test suites (npm test)
```

## Limits (be honest in the demo)

- **Illustration, not a forecast.** The water is a level plane: it does not model flow, walls, drains or timing.
- AI-generated models are approximate; set the real height for best results.
- Rooms from one photo are AI reconstructions without a true scale; Waterline scales them to the ceiling height you set, so indoor depths are a guide.
- Searching a neighbourhood (rather than a street address) lands on its middle, which can be a yard, a roof edge or a riverbank. Click your street to move the spot.
- The global river model has ~90 m cells: it can miss a street by one cell or overstate depth near river channels, and it has no flash or coastal floods.
- Higher-ground search uses bare-earth terrain (~30 m), so small embankments or walls may be missed. It is planning help, not an evacuation order.

## Data and credits

- River flood depths: JRC / Copernicus Emergency Management Service, *Global river flood hazard maps* v2.1 (CC BY 4.0, © European Union).
- Walking routes: FOSSGIS routing server (OSRM), data © OpenStreetMap contributors.
- Moving-water facts: US National Weather Service, “Turn Around Don’t Drown”.
- The public server caps new generations per day and per visitor (`MAX_GENERATIONS_PER_DAY`, `MAX_GENERATIONS_PER_IP_PER_HOUR`).

## Demo and exploration upgrades

- **Try a demo** loads the Kerrville example, places the SUV and animates an illustrative flood.
- Every Library object is a Lux3D model shown at its real height. Photo-made models show their source photo in the Library list. Depth detective offers every Library object with a known height.
- Objects support Move, Duplicate and up to 30 undo steps, including removal, height and rotation edits. Press Esc to cancel placement or moving.
- **Depth detective** compares your height prediction with a library object's top; it does not predict buoyancy or safety.
- Water labels distinguish manual, shared, example and modelled depths. Missing dataset coverage is reported separately from zero modelled depth. Depths above 3 m are labelled as capped.
- The mobile map stays visible above a separately scrolling control panel.
- Browser verification: `node --env-file-if-exists=.env scripts/verify-browser.mjs` uses installed Microsoft Edge through Playwright. It does not request new paid models.

## Hackathon package and verification

The official event is https://www.aholo.ai/hackathon and submissions go through its own **My Submission** portal, not Devpost. Deadline: **19 November 2026, 06:00 EST / 12:00 noon in Lagos**. Lux3D is required for core content or workflow. A PDF/PPT report and a working demo link or actual-app video are required; source and a public X post using `#Manycorehackathon` are bonus items.

Run `npm test` for server/client logic checks and `npm run verify:demo` for the real Cesium browser flow using Microsoft Edge. The browser check blocks all external network requests, uses the existing Lux3D GLB, and covers animation, placement, undo, challenge, higher-ground example, share reload, JSON import/export, PNG export and mobile layout. It does not verify live map services or spend credits on generation.

Building the submission package (all scripts use the installed Microsoft Edge, on the GPU where available):

1. `node --env-file-if-exists=.env scripts/capture-report.mjs`: screenshots of the real app (homepage, Kerrville, Paiporta, Studio, phone) and renders of the Lux3D assets into `submission/report/`. Uses live map services; no new generation.
2. `npm run submission`: builds `submission/Waterline-project-report.pdf` (a 12-page 16:9 deck), `lux3d-evidence.json` for every Library model, a checklist, an X post draft and the source archive.
3. `node --env-file-if-exists=.env scripts/record-demo.mjs`: records the captioned demo video `submission/waterline-demo.webm` from the real app. It makes **one live Lux3D generation** and cuts loading waits (captions say where time was skipped). Needs Playwright's encoder: `npx playwright install ffmpeg`, with `PLAYWRIGHT_BROWSERS_PATH` set to `.playwright`.

4. `node scripts/webm-to-mp4.mjs submission/waterline-demo.webm submission/waterline-demo.mp4`: an MP4 (H.264) copy for upload forms that need it, recorded by Edge's MediaRecorder and verified by playing it back.

None of the scripts register, publish, post or submit anything. Confirm your team of 1–3 in the official portal, even if solo, and review third-party terms in `THIRD_PARTY_NOTICES.txt`. The Family SUV's original prompt was not recorded (it predates prompt logging); its task ID and file hashes are.

## Hosting

Deploy to a Node host using `npm ci --omit=dev` and `npm start`, or build the supplied Dockerfile. Set keys as host secrets; never upload `.env`. Studio works without keys. `/api/health` reports application and Studio-asset readiness. Set `TRUST_PROXY=1` only behind a trusted proxy that replaces forwarding headers. Persist `.waterline/tasks` and `public/models/generated` on disk to keep tasks and new models through redeploys. Daily/IP generation quotas are process-local; use a shared persistent quota store before scaling beyond one process.

Real street mode still depends on external Cesium/Google, JRC and routing availability. These live services and Docker deployment are not claimed as verified by the offline browser checks. No public deployment or event submission is performed by these packaging scripts.
