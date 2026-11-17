// Original illustrative geometry. This is not a reconstruction of a real street.
export const STUDIO = { lon: -99.142402, lat: 30.043724 };
const R = 6_378_137;
export function studioHeight(longitude, latitude) {
  const east = (longitude - STUDIO.lon * Math.PI / 180) * R * Math.cos(STUDIO.lat * Math.PI / 180);
  return Math.max(0, east - 38) * 0.08;
}

export function pickStudioGround(C, ray) {
  const frame = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(STUDIO.lon, STUDIO.lat));
  const inverse = C.Matrix4.inverseTransformation(frame, new C.Matrix4());
  const origin = C.Matrix4.multiplyByPoint(inverse, ray.origin, new C.Cartesian3());
  const direction = C.Matrix4.multiplyByPointAsVector(inverse, ray.direction, new C.Cartesian3());
  const hits = [];
  for (const slope of [0, .08]) {
    const denominator = direction.z - slope * direction.x;
    if (Math.abs(denominator) < 1e-10) continue;
    const t = (.07 - slope * 38 - origin.z + slope * origin.x) / denominator;
    if (t < 0) continue;
    const x = origin.x + t * direction.x, y = origin.y + t * direction.y;
    if (x < -150 || x > 220 || y < -180 || y > 180 || (slope === 0 ? x > 38 : x < 38)) continue;
    hits.push(t);
  }
  if (!hits.length) return null;
  const carto = C.Cartographic.fromCartesian(C.Ray.getPoint(ray, Math.min(...hits)));
  carto.height = studioHeight(carto.longitude, carto.latitude) + .07;
  return carto;
}

export async function createStudio(C, viewer) {
  const lon = C.Math.toRadians(STUDIO.lon), lat = C.Math.toRadians(STUDIO.lat);
  const point = (e, n, h = 0) => C.Cartesian3.fromRadians(lon + e / (R * Math.cos(lat)), lat + n / R, h);
  const frame = C.Transforms.eastNorthUpToFixedFrame(point(0, 0));
  const instances = [], surfaces = new Map();
  let seed = 1741;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const color = (value) => C.Color.fromCssColorString(value);
  const transform = (e, n, h) => C.Matrix4.multiplyByTranslation(frame, new C.Cartesian3(e, n, h), new C.Matrix4());
  const box = (e, n, h, width, depth, height, shade) => instances.push(new C.GeometryInstance({
    geometry: C.BoxGeometry.fromDimensions({ dimensions: new C.Cartesian3(width, depth, height), vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT }),
    modelMatrix: transform(e, n, h), attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(color(shade)) },
  }));
  const cylinder = (e, n, h, length, topRadius, bottomRadius, shade) => instances.push(new C.GeometryInstance({
    geometry: new C.CylinderGeometry({ length, topRadius, bottomRadius, slices: 9, vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT }),
    modelMatrix: transform(e, n, h), attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(color(shade)) },
  }));
  const leaves = (e, n, h, x, y, z, shade) => instances.push(new C.GeometryInstance({
    geometry: new C.EllipsoidGeometry({ radii: new C.Cartesian3(x, y, z), stackPartitions: 7, slicePartitions: 9, vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT }),
    modelMatrix: transform(e, n, h), attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(color(shade)) },
  }));
  // Locally bundled CC0 photo surfaces, with seeded originals for roof/cream variants.
  // All source/licence metadata is in public/textures/sources.json.
  const texture = (kind, base) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = base; ctx.fillRect(0, 0, 512, 512);
    const pixels = ctx.getImageData(0, 0, 512, 512);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const noise = (random() - .5) * (kind === 'asphalt' ? 34 : 20);
      for (let k = 0; k < 3; k++) pixels.data[i + k] += noise;
    }
    ctx.putImageData(pixels, 0, 0);
    if (kind === 'brick') {
      for (let y = 0; y < 512; y += 32) {
        ctx.fillStyle = '#b1a38f'; ctx.fillRect(0, y, 512, 2);
        for (let x = (y / 32 % 2) * -32; x < 512; x += 64) {
          ctx.fillRect(x, y, 2, 32);
          ctx.fillStyle = `rgba(50,30,20,${random() * .12})`; ctx.fillRect(x + 3, y + 3, 59, 27); ctx.fillStyle = '#b1a38f';
        }
      }
    } else if (kind === 'paving' || kind === 'roof') {
      const step = kind === 'roof' ? 32 : 128;
      ctx.strokeStyle = kind === 'roof' ? '#20282c80' : '#888a7d65'; ctx.lineWidth = 2;
      for (let y = 0; y < 512; y += step) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke();
        for (let x = (y / step % 2) * -64; x < 512; x += 128) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + step); ctx.stroke(); }
      }
    } else if (kind === 'asphalt') {
      for (let i = 0; i < 6500; i++) { ctx.fillStyle = random() > .5 ? '#a7a99a35' : '#111d2035'; ctx.fillRect(random() * 512, random() * 512, 1 + random() * 2, 1); }
    } else if (kind === 'grass') {
      for (let i = 0; i < 16000; i++) { ctx.fillStyle = random() > .5 ? '#33482c35' : '#bdd18b35'; ctx.fillRect(random() * 512, random() * 512, 1, random() * 6); }
    }
    return canvas;
  };
  const flatNormal = document.createElement('canvas'); flatNormal.width = flatNormal.height = 2;
  const normalContext = flatNormal.getContext('2d'); normalContext.fillStyle = '#8080ff'; normalContext.fillRect(0, 0, 2, 2);
  const makeTexture = (source) => {
    const image = new C.Texture({ context: viewer.scene.context, source, sampler: new C.Sampler({
      wrapS: C.TextureWrap.REPEAT, wrapT: C.TextureWrap.REPEAT,
      minificationFilter: C.TextureMinificationFilter.LINEAR_MIPMAP_LINEAR,
      magnificationFilter: C.TextureMagnificationFilter.LINEAR, maximumAnisotropy: 8,
    }) });
    image.generateMipmap();
    return image;
  };
  const photos = new Map();
  await Promise.all(['asphalt', 'brick', 'paving', 'grass'].flatMap(kind => ['diff', 'normal'].map(async channel => {
    const image = new Image(); image.src = `/textures/${kind}-${channel}.jpg`; await image.decode();
    photos.set(`${kind}-${channel}`, makeTexture(image));
  })));
  const material = (kind, base, specular = .04, photo = true) => {
    const result = new C.Material({ translucent: false, fabric: {
    type: 'StudioSurface', uniforms: {
      image: C.Material.DefaultImageId,
      normalImage: C.Material.DefaultImageId,
      normalStrength: photo ? .55 : 0, gloss: specular, surfaceColor: color(base),
    },
    source: `czm_material czm_getMaterial(czm_materialInput materialInput) {
      czm_material m = czm_getDefaultMaterial(materialInput);
      float detail = clamp(1.0 - length(materialInput.positionToEyeEC) / 240.0, 0.1, 1.0);
      m.diffuse = mix(surfaceColor.rgb, texture(image, materialInput.st).rgb, detail);
      vec3 N = normalize(materialInput.normalEC);
      vec3 p1 = dFdx(-materialInput.positionToEyeEC), p2 = dFdy(-materialInput.positionToEyeEC);
      vec2 uv1 = dFdx(materialInput.st), uv2 = dFdy(materialInput.st);
      vec3 a = cross(p2, N), b = cross(N, p1);
      vec3 T = a * uv1.x + b * uv2.x, B = a * uv1.y + b * uv2.y;
      float scale = inversesqrt(max(max(dot(T, T), dot(B, B)), 0.00000001));
      vec3 mapNormal = texture(normalImage, materialInput.st).rgb * 2.0 - 1.0;
      mapNormal.xy *= normalStrength * detail;
      m.normal = normalize(mat3(T * scale, B * scale, N) * normalize(mapNormal));
      m.specular = gloss; m.shininess = 24.0; return m;
    }`,
    } });
    result.uniforms.image = photo ? photos.get(`${kind}-diff`) : makeTexture(texture(kind, base));
    result.uniforms.normalImage = photo ? photos.get(`${kind}-normal`) : makeTexture(flatNormal);
    return result;
  };
  const materials = {
    grass: material('grass', '#82946a'), asphalt: material('asphalt', '#42494a', .12),
    paving: material('paving', '#b9b4a5'), brick: material('brick', '#9d6953'),
    cream: material('brick', '#c4b6a0', .04, false), roof: material('roof', '#5b6263', .12, false),
  };
  const quad = (corners, key, width, height) => {
    const points = corners.map(([e, n, h]) => point(e, n, h));
    const edgeA = C.Cartesian3.subtract(points[1], points[0], new C.Cartesian3());
    const edgeB = C.Cartesian3.subtract(points[3], points[0], new C.Cartesian3());
    const normal = C.Cartesian3.normalize(C.Cartesian3.cross(edgeA, edgeB, new C.Cartesian3()), new C.Cartesian3());
    const geometry = new C.Geometry({ attributes: {
      position: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array(points.flatMap(p => [p.x, p.y, p.z])) }),
      normal: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array(Array.from({ length: 4 }, () => [normal.x, normal.y, normal.z]).flat()) }),
      st: new C.GeometryAttribute({ componentDatatype: C.ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: new Float32Array([0, 0, width, 0, width, height, 0, height]) }),
    }, indices: new Uint16Array([0, 1, 2, 0, 2, 3]), primitiveType: C.PrimitiveType.TRIANGLES, boundingSphere: C.BoundingSphere.fromPoints(points) });
    if (!surfaces.has(key)) surfaces.set(key, []);
    surfaces.get(key).push(new C.GeometryInstance({ geometry }));
  };
  const surface = (west, south, east, north, key, lift = 0, tileSize = 4) => {
    const corners = [[west, south], [east, south], [east, north], [west, north]];
    quad(corners.map(([e, n]) => [e, n, Math.max(0, e - 38) * .08 + lift]), key, (east - west) / tileSize, (north - south) / tileSize);
  };
  viewer.scene.globe.show = false;
  viewer.scene.skyBox.show = false;
  viewer.scene.skyAtmosphere.show = true;
  viewer.scene.backgroundColor = color('#c8d8df');
  viewer.shadows = true;
  viewer.shadowMap.size = 2048;
  viewer.shadowMap.softShadows = true;
  viewer.shadowMap.darkness = .5;
  viewer.shadowMap.maximumDistance = 350;
  surface(-1200, -1400, 38, 1400, 'grass', -.03, 5);
  surface(38, -1400, 1200, 1400, 'grass', -.03, 5);
  // Two-lane carriageway, raised sidewalks and a connected side street.
  surface(-9.3, -160, 9.3, 160, 'paving', .14, 2);
  surface(-6, -160, 6, 160, 'asphalt', .07, 5);
  surface(-110, -9.3, 38, 9.3, 'paving', .14, 2);
  surface(-110, -6, 38, 6, 'asphalt', .075, 5);
  for (let n = -150; n <= 150; n += 12) {
    if (Math.abs(n) < 15) continue;
    box(0, n, .092, .12, 4.5, .012, '#e0dcc5');
  }
  for (const e of [-6.15, 6.15]) {
    box(e, 82, .13, .24, 156, .21, '#b9b8ad');
    box(e, -82, .13, .24, 156, .21, '#b9b8ad');
  }
  for (let e = -5.4; e < 6; e += 1.2) box(e, -13, .094, .65, 3.5, .015, '#e2e0d2');
  for (const e of [-5.65, 5.65]) for (const n of [-8, 12, 46, 82, -50, -88]) {
    box(e, n, .082, .4, .72, .018, '#303a39');
    for (let k = 0; k < 5; k++) box(e, n - .28 + k * .13, .097, .34, .035, .012, '#77817b');
  }
  const window = (side, e, n, z, w = 1.25, h = 1.5) => {
    box(e, n, z, .16, w + .18, h + .18, '#d5d2c5');
    box(e - side * .09, n, z, .035, w, h, '#304b56');
    box(e - side * .12, n, z + h * .2, .025, w - .04, .06, '#7c9295');
    box(e - side * .13, n, z, .03, .045, h, '#d0cfc3');
    box(e - side * .18, n, z - h / 2 - .1, .4, w + .35, .12, '#cbc8b8');
  };
  for (const side of [-1, 1]) for (const [index, n] of [-113, -82, -51, -23, 24, 53, 84, 115].entries()) {
    const near = side * 14, far = side * (index % 2 ? 26 : 27), south = n - 9.5, north = n + 9.5;
    const wallHeight = index % 3 === 0 ? 6.8 : 6.1, key = (index + (side > 0 ? 1 : 0)) % 3 ? 'brick' : 'cream';
    const west = Math.min(near, far), east = Math.max(near, far);
    box((west + east) / 2, n, wallHeight / 2 + .18, east - west, 19, wallHeight, '#c2b7a3');
    // Slightly offset, correctly UV-mapped facades and slate roof slopes.
    quad([[near - side * .02, south, .2], [near - side * .02, north, .2], [near - side * .02, north, wallHeight], [near - side * .02, south, wallHeight]], key, 19 / 2.6, wallHeight / 1.3);
    quad([[west, south - .02, .2], [east, south - .02, .2], [east, south - .02, wallHeight], [west, south - .02, wallHeight]], key, (east - west) / 2.6, wallHeight / 1.3);
    const ridge = (west + east) / 2, roofTop = wallHeight + 2.5;
    quad([[west, south - .025, wallHeight], [east, south - .025, wallHeight], [ridge, south - .025, roofTop], [ridge, south - .025, roofTop]], key, (east - west) / 2.6, 2.5 / 1.3);
    quad([[west, north + .025, wallHeight], [east, north + .025, wallHeight], [ridge, north + .025, roofTop], [ridge, north + .025, roofTop]], key, (east - west) / 2.6, 2.5 / 1.3);
    quad([[west - .4, south - .45, wallHeight], [ridge, south - .45, roofTop], [ridge, north + .45, roofTop], [west - .4, north + .45, wallHeight]], 'roof', 4, 7);
    quad([[ridge, south - .45, roofTop], [east + .4, south - .45, wallHeight], [east + .4, north + .45, wallHeight], [ridge, north + .45, roofTop]], 'roof', 4, 7);
    box(near - side * .12, n, wallHeight - .05, .24, 19.8, .18, '#494b45');
    box(far + side * .12, n, wallHeight - .05, .24, 19.8, .18, '#494b45');
    box(near - side * .12, north - .2, wallHeight / 2, .14, .14, wallHeight, '#666a60');
    box(ridge + side * 2, n + 5, roofTop - .3, .7, .85, 1.6, '#9c7862');
    box(ridge + side * 2, n + 5, roofTop + .55, .85, 1, .12, '#a7a396');
    for (const dy of [-6.2, -2.7, 3.5, 6.7]) {
      window(side, near - side * .08, n + dy, 4.5);
      if (dy !== -2.7) window(side, near - side * .08, n + dy, 1.65, 1.3, 1.6);
    }
    const door = n - 2.7;
    box(near - side * .1, door, 1.25, .15, 1.2, 2.2, '#304d48');
    box(near - side * .2, door, 1.7, .05, .65, .8, '#607c80');
    box(near - side * .23, door + .38, 1.1, .06, .06, .06, '#c6ab72');
    box(near - side * .75, door, .2, 1.6, 1.7, .25, '#a9aa9f');
    box(near - side * .6, door, 2.55, 1.5, 1.8, .13, '#747d72');
    surface(Math.min(side * 9.5, near), door - .75, Math.max(side * 9.5, near), door + .75, 'paving', .16, 1);
    for (const dy of [-8, 8]) {
      box(side * 10.2, n + dy, .48, .3, 2.2, .72, '#aaa18e');
      leaves(side * 10.2, n + dy, 1, .6, 1.2, .65, '#566e49');
    }
    // Front garden boundary and a letterbox bring the geometry to human scale.
    box(side * 10, n + 5.5, .54, .3, 5.7, .8, '#aa9b80');
    box(side * 10, n + 2.7, .68, .43, .43, 1.1, '#b5aa92');
    box(near - side * .24, door + 1.2, 1.5, .12, .5, .3, '#505850');
  }
  for (const e of [-8, 8]) for (const n of [-100, -65, -32, 34, 69, 103]) {
    cylinder(e, n, 1.7, 3.4, .13, .22, '#76634e');
    for (let j = 0; j < 10; j++) {
      const angle = random() * Math.PI * 2, radius = random() * 1.9;
      const shades = ['#586f46', '#698254', '#748c5c', '#4e6942'];
      leaves(e + Math.cos(angle) * radius, n + Math.sin(angle) * radius, 4.6 + (random() - .4) * 2.2, 1.3 + random() * .6, 1.2 + random() * .7, 1.5 + random() * .5, shades[j % shades.length]);
    }
  }
  for (const e of [-7.2, 7.2]) for (const n of [-72, -19, 20, 74]) {
    cylinder(e, n, 2.85, 5.7, .055, .095, '#5a6661');
    box(e, n, 5.75, .16, .9, .13, '#53615c');
    box(e, n - .2, 5.67, .23, .43, .04, '#d4dccf');
  }
  for (const side of [-1, 1]) for (const n of [-14, 14]) {
    box(side * 8, n, .72, .16, .16, 1.3, '#575e55');
    box(side * 8, n, 1.4, .23, .23, .12, '#d5d0b5');
  }
  for (const [key, geometryInstances] of surfaces) viewer.scene.primitives.add(new C.Primitive({
    geometryInstances, appearance: new C.MaterialAppearance({ material: materials[key], materialSupport: C.MaterialAppearance.MaterialSupport.TEXTURED, translucent: false, closed: false, faceForward: true }),
    // Tiled UVs exceed 1. Cesium's compressed ST format assumes the 0..1 range.
    compressVertices: false, asynchronous: false, shadows: key === 'roof' ? C.ShadowMode.ENABLED : C.ShadowMode.RECEIVE_ONLY, allowPicking: false,
  }));
  viewer.scene.primitives.add(new C.Primitive({ geometryInstances: instances,
    appearance: new C.PerInstanceColorAppearance({ translucent: false, closed: true }),
    asynchronous: false, shadows: C.ShadowMode.ENABLED, allowPicking: false,
  }));
  viewer.camera.setView({ destination: point(14, -31, 9), orientation: { heading: C.Math.toRadians(-22), pitch: C.Math.toRadians(-14), roll: 0 } });
  return { geometryInstances: instances.length + [...surfaces.values()].reduce((n, items) => n + items.length, 0), drawGroups: surfaces.size + 1 };
}
