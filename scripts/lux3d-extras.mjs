// Use more of Lux3D on the Library models, beyond photo/text-to-3D:
//
//   rig      Adult person -> humanoid auto-rigging -> Walk_Loop retarget (in place)
//            => public/models/extras/adult-person-walk.glb   (walks the evacuation route)
//   export   Family SUV + Front door -> multi-format export (true-scale copy)
//            => public/models/extras/<id>.usdz (iPhone AR Quick Look) and <id>.stl (3D print)
//   parts    Family SUV -> part splitting
//            => public/models/extras/family-suv-parts.glb    (which parts are under water)
//   material Family SUV render + prompt -> multimodal-to-image (a mud-stained reference)
//            -> material transfer => public/models/extras/family-suv-flooded.glb (after the flood)
//   articulation (opt-in) Front door -> articulation (a URDF: frame + door leaf + hinge joint), turned
//            into one GLB with a door-open clip => public/models/extras/front-door-open.glb
//
//   node --env-file-if-exists=.env scripts/lux3d-extras.mjs                 # rig, export, parts, material
//   node --env-file-if-exists=.env scripts/lux3d-extras.mjs --only rig,parts --force
//   node --env-file-if-exists=.env scripts/lux3d-extras.mjs --only articulation
//
// Idempotent: a step whose outputs already exist is skipped unless --force (new tasks) or
// --rebuild (re-download and re-process from the saved tasks, < 100 min old). Task ids are saved
// to .waterline/extras-tasks.json as soon as they are created, so an interrupted run resumes
// polling instead of paying for a new task. Provenance goes to public/models/extras/extras.json.
// GLB outputs over 8 MB get JPEG textures (as scripts/optimise-library.mjs does); the Lux3D
// original is kept in .waterline/original-models/.

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createLux3D, downloadGlb, downloadFile, looksLike, exportUrls, retargetActions, outputError,
  WALK_ANIMATION, MATERIAL_TRANSFER_ORDER, Lux3DError,
} from '../lib/lux3d.mjs';
import { measureGlb } from '../public/glb-measure.js';
import { parseGlb, buildGlb, repack } from './optimise-library.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(ROOT, 'public', 'models');
const EXTRAS_DIR = path.join(MODELS_DIR, 'extras');
const EXTRAS_JSON = path.join(EXTRAS_DIR, 'extras.json');
const LIBRARY_JSON = path.join(MODELS_DIR, 'library.json');
const ORIGINALS = path.join(ROOT, '.waterline', 'original-models');
const WORK_DIR = path.join(ROOT, '.waterline', 'extras');
const STATE_FILE = path.join(ROOT, '.waterline', 'extras-tasks.json');
const POLL = { intervalMs: 6_000, timeoutMs: 20 * 60_000 };
const RESUME_MAX_AGE_MS = 100 * 60_000; // result URLs expire after 2 h
const MAX_GLB_BYTES = 8 * 1024 * 1024;
const STEPS = ['rig', 'export', 'parts', 'material', 'articulation'];
const DEFAULT_STEPS = ['rig', 'export', 'parts', 'material'];
const ENDPOINT = {
  rig: '/global/lux3d/v1/animations/rig/task/create',
  retarget: '/global/lux3d/v1/animations/retarget/task/create',
  export: '/global/lux3d/v1/multi-format-export/task/create',
  partSplit: '/global/lux3d/v1/part-split/task/create',
  image: '/global/lux3d/v1/generate/multimodal-to-image/task/create',
  imageTo3D: '/global/lux3d/v1/generate/img-to-3d/task/create',
  material: '/global/lux3d/v1/generate/material-transfer/task/create',
  articulation: '/global/lux3d/v1/articulation-animation/task/create',
};
const FLOODED_PROMPT = 'The same SUV from the same camera angle, after a muddy river flood: brown silt and dried mud caked '
  + 'on the tyres, wheels, bumpers and lower doors, a clear dirty tide line along the body at window-sill height, '
  + 'water stains and grime above it, dull dirty paint and glass. Photorealistic, plain white background, no water, no people.';
const A_POSE_PROMPT = 'The same man with the same face, hair and clothes (grey t-shirt, blue jeans, white trainers), full body, '
  + 'front view, standing in a neutral A-pose for 3D character rigging: both arms straight and held out about 45 degrees '
  + 'away from the body, hands open, legs slightly apart, feet flat. Photorealistic, plain white background, even lighting.';
const DOOR_PROMPT ='Keep the door frame fixed. Add a hinge joint on one vertical edge of the door leaf so the door '
  + 'swings open about 90 degrees and then closes again slowly.';

const { values: args } = parseArgs({
  options: { only: { type: 'string' }, force: { type: 'boolean', default: false }, rebuild: { type: 'boolean', default: false } },
});
const steps = args.only ? args.only.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_STEPS;
const unknownStep = steps.find((s) => !STEPS.includes(s));
if (unknownStep) {
  console.error(`Unknown step "${unknownStep}". Steps: ${STEPS.join(', ')}`);
  process.exit(1);
}
const force = args.force;
const rebuild = force || args.rebuild; // --rebuild: redo outputs from saved tasks (no new credits)

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = (file) => access(file).then(() => true, () => false);
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
const log = (step, message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${step.padEnd(9)} ${message}`);
const round3 = (values) => values.map((v) => Math.round(v * 1000) / 1000);

// ---------- small serialised JSON stores ----------

function jsonStore(file, fallback) {
  let data;
  let chain = Promise.resolve();
  return {
    async load() {
      try { data = JSON.parse(await readFile(file, 'utf8')); } catch { data = structuredClone(fallback); }
      return data;
    },
    get: () => data,
    update(mutate) {
      chain = chain.then(async () => {
        mutate(data);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
      });
      return chain;
    },
  };
}

const state = jsonStore(STATE_FILE, { tasks: {} });
const provenance = jsonStore(EXTRAS_JSON, []);

function record(entry) {
  return provenance.update((list) => {
    const index = list.findIndex((e) => e.id === entry.id);
    if (index >= 0) list[index] = entry; else list.push(entry);
  });
}

// ---------- Lux3D helpers ----------

const lux = createLux3D({ apiKey: process.env.LUX3D_API_KEY, baseUrl: process.env.LUX3D_BASE_URL || undefined, timeoutMs: 60_000 });

const uploads = new Map(); // sha256 -> Promise<url>
function upload(bytes, filename, step) {
  const key = sha256(bytes);
  if (!uploads.has(key)) {
    log(step, `uploading ${filename} (${mb(bytes.length)})${bytes.length > 5_242_880 ? ' in parts' : ''}…`);
    uploads.set(key, lux.uploadFile(bytes, filename).catch((error) => { uploads.delete(key); throw error; }));
  }
  return uploads.get(key);
}

/** Create (or resume) a task and wait for it, persisting its id the moment it exists. */
async function runTask(key, step, create) {
  const saved = state.get().tasks[key];
  let taskId;
  if (!force && saved && Date.now() - Date.parse(saved.createdAt) < RESUME_MAX_AGE_MS) {
    taskId = saved.taskId;
    log(step, `resuming task ${taskId} (${key})`);
  } else if (args.rebuild && !force) {
    throw new Lux3DError(`--rebuild needs a saved task for ${key} (none, or older than 100 min); use --force to pay for a new one`);
  } else {
    taskId = await create();
    await state.update((s) => { s.tasks[key] = { taskId, createdAt: new Date().toISOString() }; });
    log(step, `created task ${taskId} (${key})`);
  }
  const started = Date.now();
  let lastLog = 0;
  try {
    const task = await lux.waitForTask(taskId, {
      ...POLL,
      onProgress: (t, ms) => {
        if (ms - lastLog >= 60_000) { lastLog = ms; log(step, `task ${taskId} ${t.state} ${Math.round(ms / 1000)}s`); }
      },
    });
    // A resumed task keeps the duration measured when it first finished.
    const seconds = state.get().tasks[key]?.seconds ?? Math.round((Date.now() - started) / 1000);
    await state.update((s) => { if (s.tasks[key]) s.tasks[key].seconds = seconds; });
    log(step, `task ${taskId} succeeded after ${seconds}s`);
    return { ...task, taskId, seconds };
  } catch (error) {
    await state.update((s) => { delete s.tasks[key]; }); // never resume a failed task
    throw error;
  }
}

// ---------- GLB / STL / USDZ inspection ----------

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readFloats(json, bin, accessorIndex) {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor || accessor.componentType !== 5126 || accessor.sparse || accessor.bufferView == null) return null;
  const view = json.bufferViews[accessor.bufferView];
  const width = COMPONENTS[accessor.type] ?? 1;
  const stride = view.byteStride || width * 4;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = [];
  for (let i = 0; i < accessor.count; i++) {
    const row = [];
    for (let c = 0; c < width; c++) row.push(bin.readFloatLE(start + i * stride + c * 4));
    out.push(row);
  }
  return out;
}

function inspectGlb(bytes) {
  const { json, bin } = parseGlb(bytes);
  let size = [NaN, NaN, NaN];
  try { size = measureGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)).size; } catch { /* no POSITION bounds */ }
  const animations = (json.animations ?? []).map((animation) => {
    let duration = 0;
    let rootTravel = 0;
    let travelNode = null;
    for (const sampler of animation.samplers ?? []) duration = Math.max(duration, json.accessors?.[sampler.input]?.max?.[0] ?? 0);
    for (const channel of animation.channels ?? []) {
      if (channel.target?.path !== 'translation') continue;
      const values = readFloats(json, bin, animation.samplers[channel.sampler].output);
      if (!values?.length) continue;
      const [a, b] = [values[0], values.at(-1)];
      const travel = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (travel > rootTravel) { rootTravel = travel; travelNode = json.nodes?.[channel.target.node]?.name ?? channel.target.node; }
    }
    return { name: animation.name ?? '', channels: animation.channels?.length ?? 0, duration: Math.round(duration * 1000) / 1000, netTranslation: Math.round(rootTravel * 1000) / 1000, netTranslationNode: travelNode };
  });
  return {
    size: round3(size),
    nodes: (json.nodes ?? []).map((n, i) => n.name ?? `node${i}`),
    meshes: (json.meshes ?? []).map((m, i) => ({ name: m.name ?? `mesh${i}`, primitives: m.primitives?.length ?? 0 })),
    materials: (json.materials ?? []).map((m, i) => m.name ?? `material${i}`),
    images: (json.images ?? []).map((img) => img.mimeType ?? 'uri'),
    skins: (json.skins ?? []).map((s) => ({ name: s.name ?? '', joints: s.joints?.length ?? 0 })),
    animations,
  };
}

function inspectStl(bytes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const add = (x, y, z) => [x, y, z].forEach((v, i) => { min[i] = Math.min(min[i], v); max[i] = Math.max(max[i], v); });
  let triangles = 0;
  let format = 'binary';
  if (bytes.length >= 84 && bytes.length === 84 + 50 * bytes.readUInt32LE(80)) {
    triangles = bytes.readUInt32LE(80);
    for (let t = 0; t < triangles; t++) {
      for (let v = 0; v < 3; v++) {
        const o = 84 + t * 50 + 12 + v * 12;
        add(bytes.readFloatLE(o), bytes.readFloatLE(o + 4), bytes.readFloatLE(o + 8));
      }
    }
  } else {
    format = 'ascii';
    for (const m of bytes.toString('latin1').matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) add(Number(m[1]), Number(m[2]), Number(m[3]));
    triangles = (bytes.toString('latin1').match(/endfacet/g) ?? []).length;
  }
  return { format, triangles, size: round3(max.map((v, i) => v - min[i])) };
}

function inspectZip(bytes) {
  // First local file header: name length at 26, extra length at 28, name at 30.
  const nameLength = bytes.readUInt16LE(26);
  return { firstEntry: bytes.toString('utf8', 30, 30 + nameLength) };
}

/** A copy of a Library GLB with a root scale so its height is the real height in metres. */
function trueScaleCopy(bytes, realHeight) {
  const { json, bin } = parseGlb(bytes);
  const height = measureGlb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)).size[1];
  const scale = realHeight / height;
  const scene = json.scenes[json.scene ?? 0];
  json.nodes.push({ name: 'waterline-true-scale', scale: [scale, scale, scale], children: scene.nodes });
  scene.nodes = [json.nodes.length - 1];
  return { bytes: buildGlb(json, bin), scale };
}

// ---------- texture shrinking for big GLBs ----------

/**
 * Drop bufferViews and accessors nothing references (lossless). Lux3D's retarget output carries
 * the original PNG textures as orphaned bufferViews (~7 MB for the person) next to the used ones.
 */
function pruneGlb(bytes) {
  const { json, bin } = parseGlb(bytes);
  if (json.extensionsUsed?.length || (json.buffers?.length ?? 0) > 1) return bytes; // extensions may hold references
  const usedAccessors = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const p of mesh.primitives ?? []) {
      Object.values(p.attributes ?? {}).forEach((i) => usedAccessors.add(i));
      if (p.indices != null) usedAccessors.add(p.indices);
      for (const target of p.targets ?? []) Object.values(target).forEach((i) => usedAccessors.add(i));
    }
  }
  for (const skin of json.skins ?? []) if (skin.inverseBindMatrices != null) usedAccessors.add(skin.inverseBindMatrices);
  for (const a of json.animations ?? []) for (const s of a.samplers ?? []) { usedAccessors.add(s.input); usedAccessors.add(s.output); }
  const accessorMap = new Map();
  const accessors = (json.accessors ?? []).filter((_, i) => usedAccessors.has(i) && accessorMap.set(i, accessorMap.size));
  const usedViews = new Set();
  for (const a of accessors) {
    if (a.bufferView != null) usedViews.add(a.bufferView);
    if (a.sparse) { usedViews.add(a.sparse.indices.bufferView); usedViews.add(a.sparse.values.bufferView); }
  }
  for (const image of json.images ?? []) if (image.bufferView != null) usedViews.add(image.bufferView);
  if (accessors.length === (json.accessors ?? []).length && usedViews.size === json.bufferViews.length) return bytes;
  const viewMap = new Map();
  const views = json.bufferViews.filter((_, i) => usedViews.has(i) && viewMap.set(i, viewMap.size));
  const remapView = (i) => viewMap.get(i);
  for (const a of accessors) {
    if (a.bufferView != null) a.bufferView = remapView(a.bufferView);
    if (a.sparse) { a.sparse.indices.bufferView = remapView(a.sparse.indices.bufferView); a.sparse.values.bufferView = remapView(a.sparse.values.bufferView); }
  }
  for (const image of json.images ?? []) if (image.bufferView != null) image.bufferView = remapView(image.bufferView);
  const remapAccessor = (i) => accessorMap.get(i);
  for (const mesh of json.meshes ?? []) {
    for (const p of mesh.primitives ?? []) {
      for (const k of Object.keys(p.attributes ?? {})) p.attributes[k] = remapAccessor(p.attributes[k]);
      if (p.indices != null) p.indices = remapAccessor(p.indices);
      for (const target of p.targets ?? []) for (const k of Object.keys(target)) target[k] = remapAccessor(target[k]);
    }
  }
  for (const skin of json.skins ?? []) if (skin.inverseBindMatrices != null) skin.inverseBindMatrices = remapAccessor(skin.inverseBindMatrices);
  for (const a of json.animations ?? []) for (const s of a.samplers ?? []) { s.input = remapAccessor(s.input); s.output = remapAccessor(s.output); }
  // Copy the kept views' bytes in their new order, then repack with 4-byte alignment.
  const kept = views.map((v) => bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
  json.accessors = accessors;
  json.bufferViews = views;
  return buildGlb(json, repack(json, bin, new Map(kept.map((b, i) => [i, b]))));
}

let codecPromise = null;
let codecLock = Promise.resolve();
async function shrinkIfLarge(name, raw, step) {
  const pruned = pruneGlb(raw);
  const original = pruned === raw ? null : { bytes: raw.length, sha256: sha256(raw), file: `.waterline/original-models/${name}` };
  if (original) log(step, `${name}: dropped unreferenced data ${mb(raw.length)} → ${mb(pruned.length)}`);
  if (original || pruned.length > MAX_GLB_BYTES) {
    await mkdir(ORIGINALS, { recursive: true });
    await writeFile(path.join(ORIGINALS, name), raw); // the Lux3D download, untouched
  }
  if (pruned.length <= MAX_GLB_BYTES) return { bytes: pruned, original };
  await mkdir(WORK_DIR, { recursive: true });
  const work = path.join(WORK_DIR, `${name}.pruned.glb`);
  await writeFile(work, pruned);
  const run = codecLock.then(async () => {
    const { optimise, encoder } = await import('./optimise-library.mjs');
    codecPromise ??= encoder();
    return optimise(work, await codecPromise);
  });
  codecLock = run.catch(() => {});
  const result = await run;
  if (!result) return { bytes: pruned, original };
  log(step, `${name}: textures re-encoded ${mb(pruned.length)} → ${mb(result.output.length)} (original in .waterline/original-models/)`);
  return { bytes: result.output, original: { bytes: raw.length, sha256: sha256(raw), file: `.waterline/original-models/${name}` } };
}

// ---------- outputs ----------

const library = JSON.parse(await readFile(LIBRARY_JSON, 'utf8'));
function libraryModel(id) {
  const entry = library.find((e) => e.id === id);
  if (!entry?.url?.startsWith('/models/library/')) throw new Error(`Library model ${id} not found`);
  return { entry, file: path.join(MODELS_DIR, entry.url.slice('/models/'.length)) };
}

async function save(name, bytes) {
  await writeFile(path.join(EXTRAS_DIR, name), bytes);
  return { file: `/models/extras/${name}`, bytes: bytes.length, sha256: sha256(bytes) };
}

async function done(...names) {
  if (rebuild) return false;
  for (const name of names) if (!await exists(path.join(EXTRAS_DIR, name))) return false;
  return true;
}

// (a) Rig the person and give them a walk cycle.
//
// Auto-rigging needs a T- or A-pose. The Library person stands arms-down, which Lux3D refuses
// (task 8384588: MODEL_NOT_RIGGABLE, "arms hang naturally against the torso"). So first re-pose
// them: multimodal-to-image turns the Library render into the same person in an A-pose, and
// image-to-3D builds that person, who is then rigged and given Walk_Loop.
async function aPosePerson(step) {
  const thumb = await readFile(path.join(MODELS_DIR, 'thumbs', 'adult-person.png'));
  const thumbUrl = await lux.uploadImage(thumb, 'adult-person.png');
  const image = await runTask('rig-walk:apose-image', step, () => lux.createMultimodalImage({ prompt: A_POSE_PROMPT, imageUrl: thumbUrl }));
  const refUrl = image.urls.find((u) => /^https?:/i.test(u));
  if (!refUrl) throw new Lux3DError(`A-pose image returned nothing: ${image.contents.join(' ')}`);
  const refBytes = await downloadFile(refUrl, { kind: 'image' });
  const ext = looksLike('png', refBytes) ? 'png' : looksLike('jpg', refBytes) ? 'jpg' : 'webp';
  const refSaved = await save(`adult-person-apose-reference.${ext}`, refBytes);
  await record({
    id: 'adult-person-apose-reference', kind: 'reference-image', input: 'adult-person', endpoint: ENDPOINT.image, taskIds: [image.taskId], seconds: [image.seconds],
    request: { prompt: A_POSE_PROMPT, img: '/models/thumbs/adult-person.png' }, createdAt: new Date().toISOString(), ...refSaved,
  });
  log(step, `saved A-pose reference image (${mb(refBytes.length)})`);
  const model = await runTask('rig-walk:apose-model', step, () => lux.createImageTo3D(refUrl, { faceCount: 60_000 }));
  if (!model.glbUrl) throw new Lux3DError(`Image-to-3D returned no GLB: ${model.contents.join(' ')}`);
  const bytes = await downloadGlb(model.glbUrl);
  await mkdir(WORK_DIR, { recursive: true });
  await writeFile(path.join(WORK_DIR, 'adult-person-apose.glb'), bytes);
  log(step, `A-pose person built (${mb(bytes.length)})`);
  return { url: model.glbUrl, image, model, reference: refSaved.file };
}

async function rigWalk() {
  const step = 'rig';
  const name = 'adult-person-walk.glb';
  if (await done(name)) return log(step, `${name} exists; skipping (use --force)`);
  const source = await aPosePerson(step);
  const url = source.url; // a Lux3D result URL can feed the next task directly

  const rig = await runTask('rig-walk:rig', step, () => lux.createHumanoidRig(url));
  const rigUrl = rig.urls.find((u) => /^https?:/i.test(u));
  if (!rigUrl) throw new Lux3DError(`Rigging returned no model: ${outputError(rig.contents) || rig.contents.join(' ')}`);
  const rigged = await downloadGlb(rigUrl);
  await mkdir(WORK_DIR, { recursive: true });
  await writeFile(path.join(WORK_DIR, 'adult-person-rigged.glb'), rigged);
  const riggedInfo = inspectGlb(rigged);
  log(step, `rigged model: ${mb(rigged.length)}, skins ${JSON.stringify(riggedInfo.skins)}`);

  const retarget = await runTask('rig-walk:retarget', step, () => lux.createAnimationRetarget(rigUrl, {
    animationIds: [WALK_ANIMATION], outputMode: 'separate', outFormat: 'glb', inPlace: true,
  }));
  const actions = retargetActions(retarget.contents);
  const walk = actions.find((a) => a.animationId === WALK_ANIMATION && a.glbUrl) ?? actions.find((a) => a.glbUrl);
  if (!walk) throw new Lux3DError(`Retarget returned no walk GLB: ${outputError(retarget.contents) || retarget.contents.join(' ')}`);
  const raw = await downloadGlb(walk.glbUrl);
  const info = inspectGlb(raw);
  const { bytes, original } = await shrinkIfLarge(name, raw, step);
  const saved = await save(name, bytes);
  const verified = info.skins.length > 0 && info.animations.length > 0;
  await record({
    id: 'adult-person-walk', kind: 'rig-walk', input: 'adult-person',
    endpoint: [ENDPOINT.image, ENDPOINT.imageTo3D, ENDPOINT.rig, ENDPOINT.retarget],
    taskIds: [source.image.taskId, source.model.taskId, rig.taskId, retarget.taskId],
    seconds: [source.image.seconds, source.model.seconds, rig.seconds, retarget.seconds],
    request: { animationIds: [WALK_ANIMATION], animateInPlace: true, outFormat: 'glb', aPoseReference: source.reference },
    note: 'The Library person (arms down) was refused by auto-rigging (task 8384588, MODEL_NOT_RIGGABLE), so the same person was re-posed in an A-pose with multimodal-to-image and rebuilt with image-to-3D before rigging.',
    createdAt: new Date().toISOString(), ...saved, ...(original && { original }),
    hasSkin: info.skins.length > 0, hasAnimation: info.animations.length > 0,
    skins: info.skins, animations: info.animations, gltfSize: info.size,
  });
  log(step, `saved ${name} (${mb(bytes.length)}); skins ${info.skins.length}, animations ${JSON.stringify(info.animations)}${verified ? '' : ' — WARNING: missing skin or animation'}`);
}

// (b) USDZ for AR Quick Look and STL for 3D printing, from a true-scale copy.
async function exportModel(id) {
  const step = 'export';
  const formats = ['usdz', 'stl'];
  const names = formats.map((f) => `${id}.${f}`);
  if (await done(...names)) return log(step, `${names.join(', ')} exist; skipping (use --force)`);
  const { entry, file } = libraryModel(id);
  const scaled = trueScaleCopy(await readFile(file), entry.realHeight);
  log(step, `${id}: true-scale copy (×${scaled.scale.toFixed(4)} → ${entry.realHeight} m tall)`);
  const url = await upload(scaled.bytes, `${id}-true-scale.glb`, step);
  const task = await runTask(`export:${id}`, step, () => lux.createMultiFormatExport(url, formats));
  const urls = exportUrls(task.contents);
  const errors = [];
  for (const format of formats) {
    try {
      if (!urls[format]) throw new Lux3DError(`export returned no ${format} (outputs: ${task.contents.map((c) => (c.startsWith('http') ? 'url' : c)).join(', ')})`);
      const bytes = await downloadFile(urls[format], { kind: format });
      const saved = await save(`${id}.${format}`, bytes);
      const details = format === 'stl' ? inspectStl(bytes) : inspectZip(bytes);
      await record({
        id: `${id}-${format}`, kind: `export-${format}`, input: id, endpoint: ENDPOINT.export, taskIds: [task.taskId], seconds: [task.seconds],
        request: { outputFormat: formats, trueScale: { realHeight: entry.realHeight, scale: Math.round(scaled.scale * 1e6) / 1e6 } },
        createdAt: new Date().toISOString(), ...saved, ...details,
      });
      log(step, `saved ${id}.${format} (${mb(bytes.length)}) ${JSON.stringify(details)}`);
    } catch (error) {
      errors.push(`${id}.${format}: ${error.message}`);
    }
  }
  if (errors.length) throw new Lux3DError(errors.join('; '));
}

// (c) Split the SUV into parts.
async function partSplit() {
  const step = 'parts';
  const name = 'family-suv-parts.glb';
  if (await done(name)) return log(step, `${name} exists; skipping (use --force)`);
  const { file } = libraryModel('family-suv');
  const url = await upload(await readFile(file), 'family-suv.glb', step);
  const task = await runTask('part-split:family-suv', step, () => lux.createPartSplit(url));
  const glbUrl = task.glbUrl ?? task.urls[0];
  if (!glbUrl) throw new Lux3DError(`Part split returned no GLB: ${outputError(task.contents) || task.contents.join(' ')}`);
  const raw = await downloadGlb(glbUrl);
  await mkdir(WORK_DIR, { recursive: true });
  await writeFile(path.join(WORK_DIR, 'family-suv-parts.lux3d.glb'), raw);
  const repaired = repairParts(raw);
  const info = inspectGlb(repaired.bytes);
  const { bytes, original } = await shrinkIfLarge(name, repaired.bytes, step);
  const saved = await save(name, bytes);
  await record({
    id: 'family-suv-parts', kind: 'part-split', input: 'family-suv', endpoint: ENDPOINT.partSplit, taskIds: [task.taskId], seconds: [task.seconds],
    createdAt: new Date().toISOString(), ...saved, ...(original && { original }),
    lux3dResult: { bytes: raw.length, sha256: sha256(raw) },
    repairs: 'Lux3D returned 5 unnamed parts with no POSITION min/max (required by glTF); bounds were computed and parts named by size and position (+Z front, +X left, the glTF convention).',
    parts: repaired.parts, meshes: info.meshes, gltfSize: info.size,
  });
  log(step, `saved ${name} (${mb(bytes.length)}); parts: ${repaired.parts.map((p) => `${p.name} [${p.heightFraction.join('–')}]`).join(', ')}`);
}

/** Add the POSITION min/max Lux3D leaves out, and name each split part (body, wheel-front-left, …). */
function repairParts(bytes) {
  const { json, bin } = parseGlb(bytes);
  const boundsOf = (accessorIndex) => {
    const accessor = json.accessors[accessorIndex];
    if (!accessor.min || !accessor.max) {
      const values = readFloats(json, bin, accessorIndex);
      if (!values) throw new Error(`POSITION accessor ${accessorIndex} cannot be read`);
      accessor.min = [Infinity, Infinity, Infinity];
      accessor.max = [-Infinity, -Infinity, -Infinity];
      for (const v of values) for (let c = 0; c < 3; c++) { accessor.min[c] = Math.min(accessor.min[c], v[c]); accessor.max[c] = Math.max(accessor.max[c], v[c]); }
    }
    return { min: accessor.min, max: accessor.max, count: accessor.count };
  };
  const parts = json.nodes.map((node, index) => {
    if (node.mesh == null) return null;
    const boxes = json.meshes[node.mesh].primitives.map((p) => boundsOf(p.attributes.POSITION));
    const min = [0, 1, 2].map((c) => Math.min(...boxes.map((b) => b.min[c])));
    const max = [0, 1, 2].map((c) => Math.max(...boxes.map((b) => b.max[c])));
    return { index, min, max, vertices: boxes.reduce((n, b) => n + b.count, 0) };
  }).filter(Boolean);
  const lowY = Math.min(...parts.map((p) => p.min[1]));
  const highY = Math.max(...parts.map((p) => p.max[1]));
  const height = highY - lowY;
  const biggest = parts.reduce((a, b) => (b.vertices > a.vertices ? b : a));
  const used = new Set();
  for (const part of parts) {
    const centre = part.min.map((v, c) => (v + part.max[c]) / 2);
    const low = part.min[1] - lowY < 0.05 * height && part.max[1] - part.min[1] < 0.6 * height;
    let name = part === biggest ? 'body'
      : low ? `wheel-${centre[2] >= 0 ? 'front' : 'rear'}-${centre[0] >= 0 ? 'left' : 'right'}` : `part-${part.index + 1}`;
    while (used.has(name)) name += '-b';
    used.add(name);
    part.name = name;
    part.heightFraction = [(part.min[1] - lowY) / height, (part.max[1] - lowY) / height].map((v) => Math.round(v * 1000) / 1000);
    const node = json.nodes[part.index];
    node.name = name;
    json.meshes[node.mesh].name ??= name;
    // Which slice of the car's height this part spans (0 = ground, 1 = roof), for "is it under water?".
    node.extras = { ...node.extras, heightFraction: part.heightFraction };
  }
  return {
    bytes: buildGlb(json, bin),
    parts: parts.map(({ name, heightFraction, vertices, min, max }) => ({ name, heightFraction, vertices, min: round3(min), max: round3(max) })),
  };
}

// (d) A mud-stained reference image (multimodal-to-image), then material transfer onto the SUV.
async function floodedMaterial() {
  const step = 'material';
  const name = 'family-suv-flooded.glb';
  if (await done(name)) return log(step, `${name} exists; skipping (use --force)`);
  const { file } = libraryModel('family-suv');
  const thumb = await readFile(path.join(MODELS_DIR, 'thumbs', 'family-suv.png'));
  const thumbUrl = await lux.uploadImage(thumb, 'family-suv.png');
  const image = await runTask('material:reference', step, () => lux.createMultimodalImage({ prompt: FLOODED_PROMPT, imageUrl: thumbUrl }));
  const refUrl = image.urls.find((u) => /^https?:/i.test(u));
  if (!refUrl) throw new Lux3DError(`Image generation returned no image: ${image.contents.join(' ')}`);
  const refBytes = await downloadFile(refUrl, { kind: 'image' });
  const ext = looksLike('png', refBytes) ? 'png' : looksLike('jpg', refBytes) ? 'jpg' : 'webp';
  const refSaved = await save(`family-suv-flooded-reference.${ext}`, refBytes);
  await record({
    id: 'family-suv-flooded-reference', kind: 'reference-image', input: 'family-suv', endpoint: ENDPOINT.image, taskIds: [image.taskId], seconds: [image.seconds],
    request: { prompt: FLOODED_PROMPT, img: '/models/thumbs/family-suv.png' }, createdAt: new Date().toISOString(), ...refSaved,
  });
  log(step, `saved reference image (${mb(refBytes.length)})`);

  const meshUrl = await upload(await readFile(file), 'family-suv.glb', step);
  const task = await runTask('material:transfer', step, () => lux.createMaterialTransfer(meshUrl, refUrl, { outputFormat: ['glb'] }));
  const glbUrl = exportUrls(task.contents, MATERIAL_TRANSFER_ORDER).glb ?? task.glbUrl;
  if (!glbUrl) throw new Lux3DError(`Material transfer returned no GLB: ${task.contents.map((c) => (c.startsWith('http') ? 'url' : c)).join(', ')}`);
  const raw = await downloadGlb(glbUrl);
  const info = inspectGlb(raw);
  const { bytes, original } = await shrinkIfLarge(name, raw, step);
  const saved = await save(name, bytes);
  await record({
    id: 'family-suv-flooded', kind: 'material-transfer', input: 'family-suv', endpoint: [ENDPOINT.image, ENDPOINT.material],
    taskIds: [image.taskId, task.taskId], seconds: [image.seconds, task.seconds],
    request: { version: 'v3.0-standard', outputFormat: ['glb'], referenceImage: refSaved.file },
    createdAt: new Date().toISOString(), ...saved, ...(original && { original }), gltfSize: info.size, images: info.images,
  });
  log(step, `saved ${name} (${mb(bytes.length)}); size ${info.size.join(' × ')}`);
}

// (opt-in) Hinge the front door so it swings open.
async function articulateDoor() {
  const step = 'artic';
  if (!rebuild && await exists(path.join(EXTRAS_DIR, 'front-door-open.glb'))) {
    return log(step, 'front-door-open exists; skipping (use --force)');
  }
  const { file } = libraryModel('front-door');
  const url = await upload(await readFile(file), 'front-door.glb', step);
  const task = await runTask('articulation:front-door', step, () => lux.createArticulation(url, DOOR_PROMPT));
  const resultUrl = task.urls.find((u) => /^https?:/i.test(u));
  if (!resultUrl) throw new Lux3DError(`Articulation returned no result: ${outputError(task.contents) || task.contents.join(' ')}`);
  const raw = await downloadFile(resultUrl, { kind: 'any' });
  let glb = raw;
  let joint = null;
  let lux3dResult;
  if (!looksLike('glb', raw)) {
    // Lux3D returns a URDF robot (urdf/robot.urdf + one GLB per link). The app can't load URDF,
    // so turn it into one GLB whose hinge node swings open and shut as a glTF animation.
    if (!looksLike('zip', raw)) throw new Lux3DError('Articulation result is neither a GLB nor a ZIP');
    await mkdir(WORK_DIR, { recursive: true });
    await writeFile(path.join(WORK_DIR, 'front-door-open.lux3d.zip'), raw);
    lux3dResult = { file: '.waterline/extras/front-door-open.lux3d.zip', bytes: raw.length, sha256: sha256(raw), format: 'URDF in ZIP' };
    ({ glb, joint } = urdfZipToAnimatedGlb(raw));
  }
  const name = 'front-door-open.glb';
  const info = inspectGlb(glb);
  const { bytes, original } = await shrinkIfLarge(name, glb, step);
  const saved = await save(name, bytes);
  await record({
    id: 'front-door-open', kind: 'articulation', input: 'front-door', endpoint: ENDPOINT.articulation, taskIds: [task.taskId], seconds: [task.seconds],
    request: { prompt: DOOR_PROMPT }, createdAt: new Date().toISOString(), ...saved, ...(original && { original }),
    ...(lux3dResult && { lux3dResult, conversion: 'URDF links merged into one GLB; the revolute joint became node "hinge" with a 5 s open-hold-close rotation clip "door-open" (Waterline, not Lux3D).' }),
    ...(joint && { joint }), nodes: info.nodes, animations: info.animations, gltfSize: info.size,
  });
  log(step, `saved ${name} (${mb(bytes.length)}); animations ${JSON.stringify(info.animations)}`);
}

// ---------- URDF (from articulation) -> one animated GLB ----------

function readZip(bytes) {
  let eocd = bytes.length - 22;
  while (eocd >= 0 && bytes.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('ZIP end record not found');
  const files = new Map();
  let p = bytes.readUInt32LE(eocd + 16);
  for (let i = 0; i < bytes.readUInt16LE(eocd + 10); i++) {
    if (bytes.readUInt32LE(p) !== 0x02014b50) throw new Error('bad ZIP central directory');
    const method = bytes.readUInt16LE(p + 10);
    const size = bytes.readUInt32LE(p + 20);
    const nameLength = bytes.readUInt16LE(p + 28);
    const name = bytes.toString('utf8', p + 46, p + 46 + nameLength);
    const local = bytes.readUInt32LE(p + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`ZIP method ${method} not supported`);
    p += 46 + nameLength + bytes.readUInt16LE(p + 30) + bytes.readUInt16LE(p + 32);
  }
  return files;
}

/** Append one GLB's scene into another glTF (json + bin chunks), returning the new root node indices. */
function appendGlb(target, bytes) {
  const { json, bin } = parseGlb(bytes);
  if (json.extensionsUsed?.length) throw new Error('GLB extensions are not supported in the merge');
  const base = Buffer.concat(target.chunks).length;
  const pad = (4 - (base % 4)) % 4;
  if (pad) target.chunks.push(Buffer.alloc(pad));
  target.chunks.push(bin);
  const t = target.json;
  const offset = (key) => (t[key] ??= []).length;
  const o = { bufferViews: offset('bufferViews'), accessors: offset('accessors'), images: offset('images'), samplers: offset('samplers'), textures: offset('textures'), materials: offset('materials'), meshes: offset('meshes'), nodes: offset('nodes') };
  const shiftTexture = (info) => info && { ...info, index: info.index + o.textures };
  t.bufferViews.push(...(json.bufferViews ?? []).map((v) => ({ ...v, buffer: 0, byteOffset: (v.byteOffset ?? 0) + base + pad })));
  t.accessors.push(...(json.accessors ?? []).map((a) => ({ ...a, ...(a.bufferView != null && { bufferView: a.bufferView + o.bufferViews }) })));
  t.images.push(...(json.images ?? []).map((img) => ({ ...img, ...(img.bufferView != null && { bufferView: img.bufferView + o.bufferViews }) })));
  t.samplers.push(...(json.samplers ?? []));
  t.textures.push(...(json.textures ?? []).map((tex) => ({ ...tex, ...(tex.source != null && { source: tex.source + o.images }), ...(tex.sampler != null && { sampler: tex.sampler + o.samplers }) })));
  t.materials.push(...(json.materials ?? []).map((m) => ({
    ...m,
    ...(m.pbrMetallicRoughness && { pbrMetallicRoughness: { ...m.pbrMetallicRoughness, baseColorTexture: shiftTexture(m.pbrMetallicRoughness.baseColorTexture), metallicRoughnessTexture: shiftTexture(m.pbrMetallicRoughness.metallicRoughnessTexture) } }),
    normalTexture: shiftTexture(m.normalTexture), occlusionTexture: shiftTexture(m.occlusionTexture), emissiveTexture: shiftTexture(m.emissiveTexture),
  })));
  t.meshes.push(...(json.meshes ?? []).map((mesh) => ({
    ...mesh,
    primitives: mesh.primitives.map((p) => ({
      ...p,
      attributes: Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, v + o.accessors])),
      ...(p.indices != null && { indices: p.indices + o.accessors }),
      ...(p.material != null && { material: p.material + o.materials }),
    })),
  })));
  t.nodes.push(...(json.nodes ?? []).map((n) => ({ ...n, ...(n.mesh != null && { mesh: n.mesh + o.meshes }), ...(n.children && { children: n.children.map((c) => c + o.nodes) }) })));
  return (json.scenes?.[json.scene ?? 0]?.nodes ?? []).map((i) => i + o.nodes);
}

function rpyToQuaternion([roll, pitch, yaw]) {
  const [cr, sr, cp, sp, cy, sy] = [Math.cos(roll / 2), Math.sin(roll / 2), Math.cos(pitch / 2), Math.sin(pitch / 2), Math.cos(yaw / 2), Math.sin(yaw / 2)];
  return [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy];
}

const multiplyQuaternions = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz,
];

function urdfZipToAnimatedGlb(zip) {
  const files = readZip(zip);
  const urdfName = [...files.keys()].find((n) => n.endsWith('.urdf'));
  if (!urdfName) throw new Error('No .urdf in the articulation result');
  const urdf = files.get(urdfName).toString('utf8');
  const dir = path.posix.dirname(urdfName);
  const links = new Map([...urdf.matchAll(/<link\s+name="([^"]+)"[\s\S]*?<mesh\s+filename="([^"]+)"/g)].map((m) => [m[1], path.posix.join(dir, m[2])]));
  const joints = [...urdf.matchAll(/<joint\s+name="([^"]+)"\s+type="([^"]+)"[\s\S]*?<\/joint>/g)].map((m) => {
    const body = m[0];
    const attr = (tag, name) => new RegExp(`<${tag}[^>]*\\b${name}="([^"]*)"`).exec(body)?.[1];
    const nums = (text, fallback) => (text ? text.trim().split(/\s+/).map(Number) : fallback);
    return {
      name: m[1], type: m[2], parent: attr('parent', 'link'), child: attr('child', 'link'),
      xyz: nums(attr('origin', 'xyz'), [0, 0, 0]), rpy: nums(attr('origin', 'rpy'), [0, 0, 0]), axis: nums(attr('axis', 'xyz'), [1, 0, 0]),
      lower: Number(attr('limit', 'lower') ?? 0), upper: Number(attr('limit', 'upper') ?? 0),
    };
  });
  const joint = joints.find((j) => j.type === 'revolute' || j.type === 'continuous');
  if (!joint || joints.length !== 1) throw new Error(`Expected one revolute joint, found ${joints.map((j) => j.type).join(', ') || 'none'}`);

  const target = { json: { asset: { version: '2.0', generator: 'Waterline (Lux3D articulation URDF -> glTF)' }, scene: 0, scenes: [{ nodes: [] }], buffers: [{ byteLength: 0 }] }, chunks: [] };
  const parentRoots = appendGlb(target, files.get(links.get(joint.parent)));
  const childRoots = appendGlb(target, files.get(links.get(joint.child)));
  const nodes = target.json.nodes;
  nodes.push({ name: joint.parent, children: parentRoots });
  const parentNode = nodes.length - 1;
  const base = rpyToQuaternion(joint.rpy);
  nodes.push({ name: 'hinge', translation: joint.xyz, rotation: base, children: childRoots, extras: { urdfJoint: joint.name, axis: joint.axis, limits: [joint.lower, joint.upper] } });
  const hinge = nodes.length - 1;
  nodes[parentNode].children.push(hinge);
  target.json.scenes[0].nodes = [parentNode];

  // Animation: closed -> fully open (the limit furthest from 0) -> hold -> closed, 5 s.
  const len = Math.hypot(...joint.axis);
  const axis = joint.axis.map((v) => v / len);
  const open = Math.abs(joint.lower) >= Math.abs(joint.upper) ? joint.lower : joint.upper || -Math.PI / 2;
  const times = [0, 2, 3, 5];
  const angles = [0, open, open, 0];
  const rotations = angles.map((a) => multiplyQuaternions(base, [...axis.map((v) => v * Math.sin(a / 2)), Math.cos(a / 2)]));
  const animBin = Buffer.alloc(times.length * 4 + rotations.length * 16);
  times.forEach((v, i) => animBin.writeFloatLE(v, i * 4));
  rotations.flat().forEach((v, i) => animBin.writeFloatLE(v, times.length * 4 + i * 4));
  const binBefore = Buffer.concat(target.chunks).length;
  const pad = (4 - (binBefore % 4)) % 4;
  target.chunks.push(Buffer.alloc(pad), animBin);
  const json = target.json;
  json.bufferViews.push({ buffer: 0, byteOffset: binBefore + pad, byteLength: times.length * 4 }, { buffer: 0, byteOffset: binBefore + pad + times.length * 4, byteLength: rotations.length * 16 });
  json.accessors.push(
    { bufferView: json.bufferViews.length - 2, componentType: 5126, count: times.length, type: 'SCALAR', min: [0], max: [times.at(-1)] },
    { bufferView: json.bufferViews.length - 1, componentType: 5126, count: rotations.length, type: 'VEC4' },
  );
  json.animations = [{ name: 'door-open', samplers: [{ input: json.accessors.length - 2, output: json.accessors.length - 1, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: hinge, path: 'rotation' } }] }];
  const bin = Buffer.concat(target.chunks);
  json.buffers[0].byteLength = bin.length;
  for (const key of ['images', 'samplers', 'textures', 'materials']) if (!json[key]?.length) delete json[key];
  return { glb: buildGlb(json, bin), joint: { name: joint.name, type: joint.type, origin: joint.xyz, axis: joint.axis, limits: [joint.lower, joint.upper] } };
}

// ---------- main ----------

await mkdir(EXTRAS_DIR, { recursive: true });
await state.load();
if (force) await state.update((s) => { s.tasks = {}; });
await provenance.load();

const jobs = [];
if (steps.includes('rig')) jobs.push(['rig', rigWalk()]);
if (steps.includes('export')) jobs.push(['export family-suv', exportModel('family-suv')], ['export front-door', exportModel('front-door')]);
if (steps.includes('parts')) jobs.push(['parts', partSplit()]);
if (steps.includes('material')) jobs.push(['material', floodedMaterial()]);
if (steps.includes('articulation')) jobs.push(['articulation', articulateDoor()]);

const results = await Promise.allSettled(jobs.map(([, job]) => job));
if (codecPromise) await (await codecPromise).close();
let failed = 0;
console.log('\nSummary');
results.forEach((result, i) => {
  const label = jobs[i][0];
  if (result.status === 'fulfilled') console.log(`  ok      ${label}`);
  else { failed += 1; console.log(`  FAILED  ${label}: ${result.reason?.message ?? result.reason}`); }
});
process.exitCode = failed ? 1 : 0;
