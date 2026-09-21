'use strict';

/*
 * Atelier Rig — automatic 2D skeleton + mesh skinning for drawn characters.
 * Runs fully on-device. The drawing's pixels are never altered: the filled
 * silhouette is only an internal map that decides which pixels move together.
 *
 * Pipeline: ink → grid mask (close gaps, fill holes) → distance transform →
 * Zhang-Suen skeleton → BFS tree from the thickest point → prune spurs →
 * limb segments → bones → geodesic weights → grid mesh → WebGL skinning.
 */
(() => {
  const GRID = 120;          // mask resolution along the long side
  const PAD = 4;             // empty cells around the drawing
  const RENDER_MAX = 2048;   // max side of the skinned output canvas

  const N8 = (w) => [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];

  function dilate(src, w, h, r){
    let cur = src;
    for (let k = 0; k < r; k++){
      const out = cur.slice();
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++){
        const i = y * w + x;
        if (cur[i]) continue;
        if (cur[i - 1] || cur[i + 1] || cur[i - w] || cur[i + w] ||
            cur[i - w - 1] || cur[i - w + 1] || cur[i + w - 1] || cur[i + w + 1]) out[i] = 1;
      }
      cur = out;
    }
    return cur;
  }

  function fillHoles(src, w, h){
    const outside = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    const push = (i) => { if (!src[i] && !outside[i]){ outside[i] = 1; queue[tail++] = i; } };
    for (let x = 0; x < w; x++){ push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++){ push(y * w); push(y * w + w - 1); }
    while (head < tail){
      const i = queue[head++], x = i % w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (i >= w) push(i - w);
      if (i < w * (h - 1)) push(i + w);
    }
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
    return out;
  }

  // Chamfer 3-4 distance to the nearest empty cell, in cells.
  function distanceTransform(mask, w, h){
    const d = new Float32Array(w * h);
    const INF = 1e9;
    for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++){
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], d[i - 1] + 3, d[i - w] + 3, d[i - w - 1] + 4, d[i - w + 1] + 4);
    }
    for (let y = h - 2; y > 0; y--) for (let x = w - 2; x > 0; x--){
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], d[i + 1] + 3, d[i + w] + 3, d[i + w + 1] + 4, d[i + w - 1] + 4);
    }
    for (let i = 0; i < d.length; i++) d[i] /= 3;
    return d;
  }

  function thin(mask, w, h){
    const img = mask.slice();
    const del = [];
    let changed = true;
    while (changed){
      changed = false;
      for (let pass = 0; pass < 2; pass++){
        del.length = 0;
        for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++){
          const i = y * w + x;
          if (!img[i]) continue;
          const p2 = img[i - w], p3 = img[i - w + 1], p4 = img[i + 1], p5 = img[i + w + 1];
          const p6 = img[i + w], p7 = img[i + w - 1], p8 = img[i - 1], p9 = img[i - w - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const a = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) +
                    (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (a !== 1) continue;
          if (pass === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
          del.push(i);
        }
        for (const i of del) img[i] = 0;
        if (del.length) changed = true;
      }
    }
    return img;
  }

  function build(sprite){
    const W = sprite.width, H = sprite.height;
    const cell = Math.max(W, H) / GRID;
    const w = Math.ceil(W / cell) + PAD * 2, h = Math.ceil(H / cell) + PAD * 2;

    // Ink occupancy at grid resolution (max pooling of alpha).
    const px = sprite.getContext('2d', {willReadFrequently:true}).getImageData(0, 0, W, H).data;
    const ink = new Uint8Array(w * h);
    for (let y = 0; y < H; y++){
      const gy = ((y / cell) | 0) + PAD;
      for (let x = 0; x < W; x++){
        if (px[(y * W + x) * 4 + 3] > 8) ink[gy * w + ((x / cell) | 0) + PAD] = 1;
      }
    }

    // Enclosed areas (found with small gaps closed) join the silhouette; the
    // closing itself does not, so real gaps between legs or arms stay open.
    const thick = dilate(ink, w, h, 2);
    const filled = fillHoles(thick, w, h);
    const interior = new Uint8Array(w * h);
    for (let i = 0; i < interior.length; i++) interior[i] = filled[i] && !thick[i] ? 1 : 0;
    const grown = dilate(interior, w, h, 2);
    const margin = dilate(ink, w, h, 1);
    const sealed = fillHoles(margin, w, h);   // narrow shapes that are fully closed
    const mask = new Uint8Array(w * h);
    let area = 0;
    for (let i = 0; i < mask.length; i++){
      if (sealed[i] || (grown[i] && filled[i])){ mask[i] = 1; area++; }
    }
    if (area < 40) return null;

    const dt = distanceTransform(mask, w, h);
    const skel = thin(mask, w, h);
    const n8 = N8(w);

    // Root: the thickest point near the middle of the skeleton (tree-diameter center),
    // so a big round head doesn't get mistaken for the body.
    let seed = -1;
    for (let i = 0; i < skel.length; i++) if (skel[i] && (seed < 0 || dt[i] > dt[seed])) seed = i;
    if (seed < 0) return null;
    const walk = (start) => {
      const dist = new Float32Array(w * h).fill(-1), from = new Int32Array(w * h).fill(-1);
      const q = [start]; dist[start] = 0;
      let far = start;
      for (let head = 0; head < q.length; head++){
        const i = q[head];
        if (dist[i] > dist[far]) far = i;
        for (const o of n8){
          const j = i + o;
          if (!skel[j] || dist[j] >= 0) continue;
          dist[j] = dist[i] + ((o === 1 || o === -1 || o === w || o === -w) ? 1 : 1.414);
          from[j] = i; q.push(j);
        }
      }
      return {dist, from, far};
    };
    const endA = walk(seed).far;
    const fromA = walk(endA);
    const diameter = fromA.dist[fromA.far];
    let center = fromA.far;
    while (fromA.dist[center] > diameter / 2) center = fromA.from[center];
    const fromCenter = walk(center).dist;
    let root = center;
    for (let i = 0; i < skel.length; i++){
      if (fromCenter[i] >= 0 && fromCenter[i] <= diameter * 0.18 && dt[i] > dt[root]) root = i;
    }

    // BFS tree over the skeleton from the root.
    const parent = new Int32Array(w * h).fill(-1);
    const depth = new Float32Array(w * h).fill(-1);
    const order = [root];
    depth[root] = 0; parent[root] = root;
    for (let head = 0; head < order.length; head++){
      const i = order[head];
      for (const o of n8){
        const j = i + o;
        if (!skel[j] || depth[j] >= 0) continue;
        depth[j] = depth[i] + ((o === 1 || o === -1 || o === w || o === -w) ? 1 : 1.414);
        parent[j] = i;
        order.push(j);
      }
    }

    // Body region: thick core around the root.
    const rootDT = dt[root];
    const isBody = new Uint8Array(w * h);
    const bodyReach = Math.max(2, rootDT * 1.1);
    for (const i of order){
      if (i === root){ isBody[i] = 1; continue; }
      const thick = rootDT >= 6 && dt[i] >= rootDT * 0.62;
      if (isBody[parent[i]] && (depth[i] <= bodyReach || thick)) isBody[i] = 1;
    }
    // The body silhouette is the union of the core's inscribed discs; limbs begin
    // where their skeleton leaves it, and every cell inside it moves with the body.
    const bodyCells = new Uint8Array(w * h);
    const paintDiscs = () => {
      for (const i of order){
        if (!isBody[i]) continue;
        if (bodyCells[i] && dt[i] < rootDT * 0.62 && i !== root) continue;
        const r = Math.max(1, dt[i] * 0.85), r2 = r * r, x0 = i % w, y0 = (i / w) | 0;
        for (let y = Math.max(0, Math.floor(y0 - r)); y <= Math.min(h - 1, Math.ceil(y0 + r)); y++){
          for (let x = Math.max(0, Math.floor(x0 - r)); x <= Math.min(w - 1, Math.ceil(x0 + r)); x++){
            if ((x - x0) * (x - x0) + (y - y0) * (y - y0) <= r2 && mask[y * w + x]) bodyCells[y * w + x] = 1;
          }
        }
      }
    };
    paintDiscs();
    for (const i of order) if (!isBody[i] && isBody[parent[i]] && bodyCells[i]) isBody[i] = 1;

    // Leaves of the BFS tree are endpoint candidates.
    const hasChild = new Uint8Array(w * h);
    for (const i of order) if (i !== root) hasChild[parent[i]] = 1;
    let ends = order.filter(i => !hasChild[i] && !isBody[i]);

    // Iteratively prune short spurs (outline bumps, staircase corners).
    const childCount = new Int32Array(w * h);
    const onPath = new Uint8Array(w * h);
    const markPaths = () => {
      onPath.fill(0); childCount.fill(0);
      for (const e of ends){
        let i = e;
        while (!onPath[i] && !isBody[i]){ onPath[i] = 1; i = parent[i]; }
      }
      for (const i of order) if (onPath[i] && i !== root) childCount[parent[i]]++;
    };
    // Remove the shortest spur first, so a staircase stub never cuts a real limb short.
    const minLimb = Math.max(3, 0.018 * GRID);
    for (let round = 0; round < 400 && ends.length; round++){
      markPaths();
      let worst = -1, worstLen = Infinity;
      ends.forEach((e, k) => {
        let i = e, len = 0;
        while (!isBody[i] && childCount[i] < 2){ len++; i = parent[i]; }
        // Spurs off the body were already swallowed by the body discs; only junction spurs need the thickness test.
        const need = isBody[i] ? minLimb : Math.max(minLimb, dt[i] * 0.9);
        if (len < need && len < worstLen){ worst = k; worstLen = len; }
      });
      if (worst < 0) break;
      ends.splice(worst, 1);
    }
    markPaths();

    // Segments run from an upper node (body or junction) down to a junction or an end.
    const segments = [];
    for (const i of order){
      if (!onPath[i]) continue;
      const lowerIsNode = childCount[i] !== 1;
      if (!lowerIsNode) continue;
      const pixels = [];
      let j = i;
      while (!isBody[j] && !(j !== i && childCount[j] >= 2)){ pixels.push(j); j = parent[j]; }
      pixels.reverse();
      segments.push({upper:j, lower:i, pixels, leaf:childCount[i] === 0});
    }
    segments.sort((a, b) => depth[a.upper] - depth[b.upper]);

    const toSprite = (i) => ({x:(i % w - PAD + 0.5) * cell, y:(((i / w) | 0) - PAD + 0.5) * cell});
    const joints = [toSprite(root)];
    const bones = [{a:0, b:0, parent:-1, kind:'body'}];
    const boneEndingAt = new Map();
    const label = new Int32Array(w * h).fill(-1);
    for (const i of order) if (isBody[i]) label[i] = 0;

    for (const seg of segments){
      if (!seg.pixels.length) continue;
      let parentBone = 0, startJoint;
      if (boneEndingAt.has(seg.upper)){
        parentBone = boneEndingAt.get(seg.upper);
        startJoint = bones[parentBone].b;
      }else{
        startJoint = joints.push(toSprite(seg.upper)) - 1;
      }
      const endJoint = joints.push(toSprite(seg.lower)) - 1;
      const split = seg.leaf && seg.pixels.length >= 8;
      const segInfo = {pixels:seg.pixels, leaf:seg.leaf};
      if (split){
        const mid = seg.pixels[seg.pixels.length >> 1];
        const midJoint = joints.push(toSprite(mid)) - 1;
        const upper = bones.push({a:startJoint, b:midJoint, parent:parentBone, seg:segInfo, part:'upper'}) - 1;
        const lower = bones.push({a:midJoint, b:endJoint, parent:upper, seg:segInfo, part:'lower'}) - 1;
        segInfo.bones = [upper, lower];
        seg.pixels.forEach((p, k) => { label[p] = k < seg.pixels.length >> 1 ? upper : lower; });
        boneEndingAt.set(seg.lower, lower);
      }else{
        const bone = bones.push({a:startJoint, b:endJoint, parent:parentBone, seg:segInfo, part:seg.leaf ? 'whole' : 'trunk'}) - 1;
        segInfo.bones = [bone];
        seg.pixels.forEach(p => { label[p] = bone; });
        boneEndingAt.set(seg.lower, bone);
      }
    }

    // Remaining skeleton pixels (pruned spurs, detached pieces) follow their ancestor or the body.
    for (const i of order){
      if (label[i] >= 0) continue;
      label[i] = label[parent[i]] >= 0 ? label[parent[i]] : 0;
    }
    for (let i = 0; i < skel.length; i++) if (skel[i] && label[i] < 0) label[i] = 0;

    const rig = {
      W, H, cell, w, h, mask, dt, skel, label, joints, bones, rootJoint:0, bodyCells,
      limbCount: bones.length - 1,
      leafCount: segments.filter(seg => seg.leaf && seg.pixels.length).length,
    };
    classify(rig);
    computeWeights(rig);
    buildMesh(rig);
    rig.sprite = sprite;
    rig.renderer = makeRenderer(rig, 1);
    if (!rig.renderer) return null;
    return rig;
  }

  // Give every bone a motion role from its own direction.
  function classify(rig){
    const {joints, bones, dt} = rig;
    const root = joints[0];
    const ups = [];
    const legs = [];
    for (let i = 1; i < bones.length; i++){
      const bone = bones[i];
      const segBones = bone.seg.bones;
      const first = bones[segBones[0]], last = bones[segBones[segBones.length - 1]];
      const a = joints[first.a], b = joints[last.b];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      bone.attach = a;
      bone.tip = b;
      if (!bone.seg.leaf) bone.role = 'trunk';
      else if (dy / len > 0.5) bone.role = 'down';
      else if (dy / len < -0.55) bone.role = 'up';
      else bone.role = a.y < root.y ? 'arm' : 'tail';
      bone.side = b.x >= a.x ? 1 : -1;
      bone.outward = a.x >= root.x ? 1 : -1;
      if (bone.role === 'up' && bone === first){
        const thick = bone.seg.pixels.reduce((s, p) => s + dt[p], 0) / bone.seg.pixels.length;
        ups.push({bone:i, thick, off:Math.abs(a.x - root.x)});
      }
    }
    // Downward limbs that reach the ground are legs; ones hanging higher are arms.
    let lowest = -Infinity;
    for (let i = 1; i < bones.length; i++) if (bones[i].role === 'down') lowest = Math.max(lowest, bones[i].tip.y);
    for (let i = 1; i < bones.length; i++){
      if (bones[i].role !== 'down') continue;
      bones[i].role = bones[i].tip.y >= lowest - rig.H * 0.2 ? 'leg' : 'arm';
      if (bones[i].role === 'leg' && bones[i] === bones[bones[i].seg.bones[0]]) legs.push(i);
    }
    // Thickest, most central upward limb is the head; other upward limbs are arms.
    ups.sort((p, q) => (q.thick - q.off * 0.02 / rig.cell) - (p.thick - p.off * 0.02 / rig.cell));
    ups.forEach((u, k) => {
      const role = k === 0 ? 'head' : 'arm';
      bones[u.bone].seg.bones.forEach(b => { bones[b].role = role; });
    });
    legs.sort((p, q) => bones[p].attach.x - bones[q].attach.x);
    legs.forEach((b, k) => { bones[b].seg.bones.forEach(x => { bones[x].phase = k % 2 ? Math.PI : 0; }); });
    let armIndex = 0;
    for (let i = 1; i < bones.length; i++){
      const bone = bones[i];
      if (bone.phase == null) bone.phase = bone.role === 'arm' ? (bone.outward > 0 ? Math.PI : 0) + (armIndex++ % 2) * 0.3 : i * 0.9;
    }
  }

  // Split segments reassign pixels to the nearer half (after a joint is moved),
  // then labels spread through the silhouette along geodesic paths.
  function computeWeights(rig){
    const {w, h, mask, skel, label, joints, bones, cell} = rig;
    const cellX = (i) => (i % w - PAD + 0.5) * cell;
    const cellY = (i) => (((i / w) | 0) - PAD + 0.5) * cell;
    const segDist = (bone, x, y) => {
      const a = joints[bone.a], b = joints[bone.b];
      const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / l2));
      return {d:Math.hypot(a.x + vx * t - x, a.y + vy * t - y), t};
    };
    for (let i = 0; i < skel.length; i++){
      if (!skel[i] || label[i] <= 0) continue;
      const pair = bones[label[i]].seg && bones[label[i]].seg.bones;
      if (!pair || pair.length < 2) continue;
      const x = cellX(i), y = cellY(i);
      label[i] = segDist(bones[pair[0]], x, y).d <= segDist(bones[pair[1]], x, y).d ? pair[0] : pair[1];
    }

    const cellLabel = new Int32Array(w * h).fill(-1);
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    for (let i = 0; i < skel.length; i++) if (skel[i] && mask[i]){ cellLabel[i] = label[i]; queue[tail++] = i; }
    const n8 = N8(w);
    while (head < tail){
      const i = queue[head++];
      for (const o of n8){
        const j = i + o;
        if (j < 0 || j >= mask.length || !mask[j] || cellLabel[j] >= 0) continue;
        cellLabel[j] = cellLabel[i];
        queue[tail++] = j;
      }
    }

    // Per-cell weights: a limb bone shares its first third with its parent.
    const cellW = new Array(w * h);
    for (let i = 0; i < mask.length; i++){
      if (!mask[i]) continue;
      const b = cellLabel[i] < 0 || rig.bodyCells[i] ? 0 : cellLabel[i];
      if (b === 0){ cellW[i] = [[0, 1]]; continue; }
      const {t} = segDist(bones[b], cellX(i), cellY(i));
      const s = Math.min(1, t / 0.34);
      const wp = 0.5 * (1 - s * s * (3 - 2 * s));
      cellW[i] = wp > 0.001 ? [[b, 1 - wp], [bones[b].parent, wp]] : [[b, 1]];
    }
    rig.cellLabel = cellLabel;
    rig.cellW = cellW;
    if (rig.vertexCells) assignVertexWeights(rig);
  }

  function buildMesh(rig){
    const {w, h, mask, cell} = rig;
    const vw = w + 1;
    const index = new Int32Array(vw * (h + 1)).fill(-1);
    const rest = [], uv = [], vertexCells = [];
    const tris = [];
    const vertex = (vx, vy) => {
      const k = vy * vw + vx;
      if (index[k] < 0){
        index[k] = rest.length / 2;
        const x = (vx - PAD) * cell, y = (vy - PAD) * cell;
        rest.push(x, y);
        uv.push(x / rig.W, y / rig.H);
        vertexCells.push([]);
      }
      return index[k];
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
      const i = y * w + x;
      if (!mask[i]) continue;
      const a = vertex(x, y), b = vertex(x + 1, y), c = vertex(x, y + 1), d = vertex(x + 1, y + 1);
      tris.push(a, b, c, b, d, c);
      vertexCells[a].push(i); vertexCells[b].push(i); vertexCells[c].push(i); vertexCells[d].push(i);
    }
    rig.rest = new Float32Array(rest);
    rig.uv = new Float32Array(uv);
    rig.tris = rest.length / 2 > 65535 ? new Uint32Array(tris) : new Uint16Array(tris);
    rig.vertexCells = vertexCells;
    rig.pos = new Float32Array(rest.length);
    assignVertexWeights(rig);
  }

  function assignVertexWeights(rig){
    const count = rig.vertexCells.length;
    const bonesOf = new Array(count);
    for (let v = 0; v < count; v++){
      const acc = new Map();
      const cells = rig.vertexCells[v];
      for (const c of cells) for (const [b, wt] of rig.cellW[c]) acc.set(b, (acc.get(b) || 0) + wt / cells.length);
      bonesOf[v] = [...acc.entries()].sort((p, q) => q[1] - p[1]).slice(0, 3);
      const sum = bonesOf[v].reduce((s, e) => s + e[1], 0) || 1;
      bonesOf[v].forEach(e => { e[1] /= sum; });
    }
    rig.vertexWeights = bonesOf;
  }

  // Forward kinematics: each bone rotates about its start joint, inheriting its parent.
  function skin(rig, angles){
    const {bones, joints, rest, pos, vertexWeights} = rig;
    const M = new Array(bones.length);
    M[0] = [1, 0, 0, 1, 0, 0];
    for (let i = 1; i < bones.length; i++){
      const P = M[bones[i].parent], j = joints[bones[i].a], th = angles[i] || 0;
      const c = Math.cos(th), s = Math.sin(th);
      // local = T(j) R T(-j)
      const la = c, lb = s, lc = -s, ld = c;
      const le = j.x - c * j.x + s * j.y, lf = j.y - s * j.x - c * j.y;
      M[i] = [
        P[0] * la + P[2] * lb, P[1] * la + P[3] * lb,
        P[0] * lc + P[2] * ld, P[1] * lc + P[3] * ld,
        P[0] * le + P[2] * lf + P[4], P[1] * le + P[3] * lf + P[5],
      ];
    }
    for (let v = 0; v < vertexWeights.length; v++){
      const x = rest[v * 2], y = rest[v * 2 + 1];
      let ox = 0, oy = 0;
      for (const [b, wt] of vertexWeights[v]){
        const m = M[b];
        ox += wt * (m[0] * x + m[2] * y + m[4]);
        oy += wt * (m[1] * x + m[3] * y + m[5]);
      }
      pos[v * 2] = ox; pos[v * 2 + 1] = oy;
    }
    return M;
  }

  // Shrink in halving steps so thin pencil lines survive; one big jump drops them.
  function downscale(source, k){
    const tw = Math.max(1, Math.round(source.width * k)), th = Math.max(1, Math.round(source.height * k));
    let cur = source;
    while (cur.width / 2 >= tw && cur.height / 2 >= th){
      const half = document.createElement('canvas');
      half.width = Math.ceil(cur.width / 2); half.height = Math.ceil(cur.height / 2);
      const c = half.getContext('2d');
      c.imageSmoothingQuality = 'high';
      c.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
    }
    if (cur.width === tw && cur.height === th) return cur;
    const out = document.createElement('canvas');
    out.width = tw; out.height = th;
    const c = out.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(cur, 0, 0, tw, th);
    return out;
  }

  // Render at the on-screen scale: the texture is pre-shrunk to match, so the GPU
  // samples it about 1:1 (no mipmaps in WebGL1 for odd sizes, so minifying there aliases).
  function makeRenderer(rig, scale){
    const sprite = rig.sprite;
    const pad = Math.max(rig.W, rig.H) * 0.45;
    const k = Math.min(1, scale, RENDER_MAX / (Math.max(rig.W, rig.H) + pad * 2));
    const texture = k < 0.98 ? downscale(sprite, k) : sprite;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round((rig.W + pad * 2) * k);
    canvas.height = Math.round((rig.H + pad * 2) * k);
    const gl = canvas.getContext('webgl', {alpha:true, premultipliedAlpha:true, preserveDrawingBuffer:true, antialias:true});
    if (!gl) return null;
    if (rig.tris instanceof Uint32Array && !gl.getExtension('OES_element_index_uint')) return null;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER,
      'attribute vec2 aPos;attribute vec2 aUV;uniform vec2 uScale;uniform float uPad;varying vec2 vUV;' +
      'void main(){vec2 p=(aPos+uPad)*uScale;gl_Position=vec4(p.x-1.0,1.0-p.y,0.0,1.0);vUV=aUV;}'));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER,
      'precision mediump float;uniform sampler2D uTex;varying vec2 vUV;void main(){gl_FragColor=texture2D(uTex,vUV);}'));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const posBuf = gl.createBuffer();
    const uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, rig.uv, gl.STATIC_DRAW);
    const aUV = gl.getAttribLocation(prog, 'aUV');
    gl.enableVertexAttribArray(aUV);
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    const idx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, rig.tris, gl.STATIC_DRAW);
    const indexType = rig.tris instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

    gl.uniform2f(gl.getUniformLocation(prog, 'uScale'), 2 * k / canvas.width, 2 * k / canvas.height);
    gl.uniform1f(gl.getUniformLocation(prog, 'uPad'), pad);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.viewport(0, 0, canvas.width, canvas.height);

    return {
      canvas, pad, scale:k,
      draw(){
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, rig.pos, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.drawElements(gl.TRIANGLES, rig.tris.length, indexType, 0);
      },
      dispose(){ const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); },
    };
  }

  // Procedural motion per role. Angles are radians, positive = clockwise on screen.
  function pose(rig, action, time, amount = 1){
    const angles = new Float32Array(rig.bones.length);
    const walk = time * 0.0085;
    const jump = Math.abs(Math.sin(time * 0.0042));
    for (let i = 1; i < rig.bones.length; i++){
      const b = rig.bones[i];
      const lower = b.part === 'lower';
      const ph = b.phase || 0;
      const raise = -b.side;          // rotating by raise * θ lifts the tip
      const spread = -b.outward;      // rotating a leg by spread * θ swings it outward
      let a = 0;
      switch (action){
        case 'walk':
          if (b.role === 'leg') a = lower ? Math.max(0, Math.sin(walk + ph - 1.2)) * 0.45 * b.side : Math.sin(walk + ph) * 0.36;
          else if (b.role === 'arm') a = Math.sin(walk + ph + Math.PI) * (lower ? 0.18 : 0.32);
          else if (b.role === 'head') a = Math.sin(walk * 2) * 0.06;
          else if (b.role === 'tail') a = Math.sin(walk * 0.8 - (lower ? 0.9 : 0)) * (lower ? 0.3 : 0.2);
          else a = Math.sin(walk) * 0.04;
          break;
        case 'hop':
          if (b.role === 'leg') a = lower ? jump * 0.35 * b.side : spread * jump * 0.3;
          else if (b.role === 'arm') a = raise * jump * (lower ? 0.25 : 0.6);
          else if (b.role === 'head') a = -jump * 0.05 * b.side;
          else if (b.role === 'tail') a = raise * jump * 0.35;
          break;
        case 'dance': {
          const beat = time * 0.0072;
          if (b.role === 'arm') a = raise * (0.35 + Math.sin(beat * 1.6 + ph) * 0.45) * (lower ? 0.8 : 1);
          else if (b.role === 'leg') a = lower ? Math.max(0, Math.sin(beat * 1.6 + ph)) * 0.4 * b.side : Math.sin(beat * 1.6 + ph) * 0.2;
          else if (b.role === 'head') a = Math.sin(beat * 1.6) * 0.16;
          else if (b.role === 'tail') a = Math.sin(beat * 1.2 - (lower ? 1 : 0)) * 0.4;
          else a = Math.sin(beat * 0.8) * 0.06;
          break;
        }
        case 'wave': {
          // Greeting a friend: arms up and waving, a happy head tilt, tail wag.
          const hi = time * 0.013;
          if (b.role === 'arm') a = lower ? Math.sin(hi + ph) * 0.45 : raise * (0.95 + Math.sin(hi * 0.5 + ph) * 0.15);
          else if (b.role === 'head') a = Math.sin(time * 0.005) * 0.12;
          else if (b.role === 'tail') a = Math.sin(hi) * 0.4;
          break;
        }
        case 'float': {
          const drift = time * 0.0022;
          if (b.role === 'trunk') a = Math.sin(drift + ph) * 0.03;
          else if (b.role === 'head') a = Math.sin(drift * 0.9) * 0.08;
          else a = Math.sin(drift + ph - (lower ? 0.8 : 0)) * (lower ? 0.28 : 0.2);
          break;
        }
        default: break;
      }
      angles[i] = a * amount;
    }
    return angles;
  }

  // Match the renderer to how big the drawing is on screen (in stage pixels per sprite pixel).
  function setScale(rig, scale){
    const want = Math.min(1, scale);
    if (Math.abs(want - rig.renderer.scale) / rig.renderer.scale < 0.15) return true;
    const next = makeRenderer(rig, want);
    if (!next) return false;
    rig.renderer.dispose();
    rig.renderer = next;
    return true;
  }

  function render(rig, angles){
    skin(rig, angles);
    rig.renderer.draw();
    return rig.renderer;
  }

  function maskAt(rig, x, y){
    const gx = Math.floor(x / rig.cell) + PAD, gy = Math.floor(y / rig.cell) + PAD;
    if (gx < 0 || gy < 0 || gx >= rig.w || gy >= rig.h) return false;
    return !!rig.mask[gy * rig.w + gx];
  }

  function moveJoint(rig, index, x, y){
    const j = rig.joints[index];
    j.x = Math.max(0, Math.min(rig.W, x));
    j.y = Math.max(0, Math.min(rig.H, y));
  }

  function refresh(rig){
    computeWeights(rig);
    classify(rig);
  }

  window.AtelierRig = {build, pose, render, setScale, maskAt, moveJoint, refresh};
})();
