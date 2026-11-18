// Inside your home: a room made by Aholo World (Gaussian splats), with the street's flood water coming in.
// three.js and Spark (the splat renderer) load only when someone opens a room.

let libraries;
function loadLibraries() {
  libraries ??= Promise.all([
    import('three'),
    import('@sparkjsdev/spark'),
    import('three/addons/controls/OrbitControls.js'),
  ]).then(([THREE, Spark, { OrbitControls }]) => ({ THREE, Spark, OrbitControls }));
  return libraries;
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];

/**
 * Open a room in `container`. Heights inside are scaled so floor-to-ceiling is `roomHeight` metres,
 * because a room rebuilt from one photo has no reliable scale of its own.
 */
export async function openRoom(container, { url, upAxis = 'Z', roomHeight = 2.5, onProgress } = {}) {
  const { THREE, Spark, OrbitControls } = await loadLibraries();
  const { SparkRenderer, SplatMesh, SplatEdit, SplatEditSdf, SplatEditSdfType, SplatEditRgbaBlendMode } = Spark;

  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  container.replaceChildren(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdff1fb);
  const camera = new THREE.PerspectiveCamera(68, 1, 0.02, 300);
  scene.add(new SparkRenderer({ renderer }));

  const room = new SplatMesh({ url, onProgress: (event) => event.total && onProgress?.(event.loaded / event.total) });
  // Aholo World says which way is up; three.js is Y-up.
  if (upAxis === 'Z') room.rotation.x = -Math.PI / 2;
  scene.add(room);
  await room.initialized;

  // Where are the floor and the ceiling? Low and high percentiles of the splat heights ignore stray splats.
  room.updateMatrixWorld(true);
  const total = room.packedSplats?.numSplats ?? room.numSplats ?? 0;
  const stride = Math.max(1, Math.floor(total / 250_000));
  const ys = [], xs = [], zs = [];
  const p = new THREE.Vector3();
  room.forEachSplat((index, center) => {
    if (index % stride) return;
    p.copy(center).applyMatrix4(room.matrixWorld);
    ys.push(p.y); xs.push(p.x); zs.push(p.z);
  });
  if (ys.length < 100) throw new Error('This room has too few points to show.');
  const sort = (a) => Float32Array.from(a).sort();
  const [sy, sx, sz] = [sort(ys), sort(xs), sort(zs)];
  const floor = percentile(sy, 0.015), ceiling = percentile(sy, 0.985);
  const rawHeight = Math.max(1e-3, ceiling - floor);
  const box = { x0: percentile(sx, 0.03), x1: percentile(sx, 0.97), z0: percentile(sz, 0.03), z1: percentile(sz, 0.97) };

  // The flood: tint every splat below the waterline, plus a faint water surface.
  const flood = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0.015 });
  const below = new SplatEditSdf({ type: SplatEditSdfType.PLANE, color: new THREE.Color(0.6, 0.55, 0.4) }); // muddy floodwater
  below.rotation.x = -Math.PI / 2;
  flood.add(below);
  scene.add(flood);
  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x7d6b4a, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }),
  );
  surface.renderOrder = 10;
  scene.add(surface);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.2;

  let scale = 1;
  let water = 0;
  function fit(height) {
    scale = Math.min(50, Math.max(0.02, height / rawHeight));
    room.scale.setScalar(scale);
    // Floor at y = 0, so water heights are metres above the floor.
    room.position.y = -floor * scale;
    const cx = ((box.x0 + box.x1) / 2) * scale, cz = ((box.z0 + box.z1) / 2) * scale;
    surface.scale.set((box.x1 - box.x0) * scale * 1.15, 1, (box.z1 - box.z0) * scale * 1.15);
    surface.position.set(cx, water, cz);
    // Stand where the photo was taken (the world's origin), at eye height, looking into the room.
    const eye = Math.min(1.8, Math.max(1.1, -floor * scale));
    camera.position.set(0, eye, 0);
    const toCentre = Math.hypot(cx, cz);
    controls.target.set(toCentre > 0.6 ? cx : 0, 1.0, toCentre > 0.6 ? cz : -1.5);
    controls.maxDistance = Math.max(4, (box.x1 - box.x0 + box.z1 - box.z0) * scale * 1.5);
    controls.update();
  }
  function setWater(metres) {
    water = Math.max(0, metres);
    surface.visible = water > 0.005;
    below.opacity = water > 0.005 ? 1 : 0;
    surface.position.y = water;
    below.position.y = water > 0.005 ? water : -1000;
  }
  fit(roomHeight);
  setWater(0);

  const resize = () => {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

  return {
    setWater,
    setRoomHeight: (height) => { fit(height); setWater(water); },
    info: () => ({ splats: total, rawHeight, scale }),
    snapshot: () => renderer.domElement.toDataURL('image/jpeg', 0.9),
    close() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      room.dispose?.();
      renderer.dispose();
      container.replaceChildren();
    },
  };
}
