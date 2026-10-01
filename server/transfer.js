'use strict';

// 仿射迁移：把一份【已发布报告】冻结的全部细胞外轮廓及孔洞，
// 由操作者在来源原图与目标原图上分别标记【顺序对应】的三个非共线点，
// 解出唯一仿射变换并映射到目标草稿图片；映射后的每个细胞都要重新通过
// 既有几何规则（越界 / 自交 / 孔洞严格在内 / 孔洞互不接触），逐细胞给出校验结果。
//
// 预览与提交共用本文件的同一套变换与校验（planTransfer），
// 保证“预览所见即提交所写”。

const geo = require('./geometry');

const EPS = 1e-9;
const MIN_POINT_DIST = 1; // 像素：定标点重合阈值，与标尺两点规则一致

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ---------- 点三元组解析 ----------

// 把请求中的 [{x,y}, {x,y}, {x,y}] 标准化为三个点；非法抛出带 side（来源/目标）的错误
function parseTriad(raw, side, bounds) {
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw new Error(`${side}标记点无效：必须恰好提供 3 个点（按顺序与另一侧一一对应），收到 ${Array.isArray(raw) ? raw.length : '非数组'} 个`);
  }
  const pts = raw.map((p, i) => {
    if (!p || !isNum(p.x) || !isNum(p.y)) {
      throw new Error(`${side}第 ${i + 1} 个标记点不是有效的像素坐标 {x, y}`);
    }
    return { x: p.x, y: p.y };
  });
  pts.forEach((p, i) => {
    if (p.x < 0 || p.y < 0 || p.x > bounds.width || p.y > bounds.height) {
      throw new Error(`${side}第 ${i + 1} 个标记点 (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) 越出图片范围（${bounds.width}×${bounds.height} 像素）`);
    }
  });
  // 重合：任一对点间距小于 1 像素
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      if (Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y) < MIN_POINT_DIST) {
        throw new Error(`${side}第 ${i + 1}、${j + 1} 个标记点重合（间距小于 ${MIN_POINT_DIST} 像素）：三个点必须互不重合`);
      }
    }
  }
  // 共线：以三角形（2×）面积判断
  const area2 = Math.abs(
    (pts[1].x - pts[0].x) * (pts[2].y - pts[0].y) -
    (pts[1].y - pts[0].y) * (pts[2].x - pts[0].x)
  );
  if (!(area2 > EPS)) {
    throw new Error(`${side}3 个标记点共线，无法确定唯一的仿射变换：请重新选择三个不共线的点`);
  }
  return pts;
}

// ---------- 仿射变换求解与应用 ----------
//
// 求 t(p) = M·p + b，使 t(src[i]) = dst[i]（i = 0,1,2）。
// M = B·A⁻¹，其中 A/B 的列为 (p1-p0, p2-p0)；det 为 M 的行列式。

function solveAffine(src, dst) {
  const a = src[1].x - src[0].x, b = src[1].y - src[0].y;
  const c = src[2].x - src[0].x, d = src[2].y - src[0].y;
  const det = a * d - b * c; // 已由非共线校验保证非 0
  const invDet = 1 / det;

  const ap = dst[1].x - dst[0].x, bp = dst[1].y - dst[0].y;
  const cp = dst[2].x - dst[0].x, dp = dst[2].y - dst[0].y;

  // A⁻¹ = (1/det) [[d, -b],[-c, a]]
  const m11 = (d * ap - b * cp) * invDet;
  const m12 = (-c * ap + a * cp) * invDet;
  const m21 = (d * bp - b * dp) * invDet;
  const m22 = (-c * bp + a * dp) * invDet;
  const tx = dst[0].x - (m11 * src[0].x + m12 * src[0].y);
  const ty = dst[0].y - (m21 * src[0].x + m22 * src[0].y);

  return {
    a: m11, b: m12, c: m21, d: m22, e: tx, f: ty,
    det: m11 * m22 - m12 * m21
  };
}

function mapPoint(affine, p) {
  return {
    x: affine.a * p.x + affine.b * p.y + affine.e,
    y: affine.c * p.x + affine.d * p.y + affine.f
  };
}

const round3 = (v) => Math.round(v * 1000) / 1000;
function roundPoint(p) { return { x: round3(p.x), y: round3(p.y) }; }

// ---------- 迁移计划（预览与提交共用） ----------
//
// sourceReport：冻结报告（hydrate 后的对象）；targetImage：目标草稿；
// srcPoints/dstPoints：两张原图上顺序对应的三个点；targetScale：目标 μm/px（未定标 null）。
// 返回 { valid, affine, source, target, cells: 逐细胞映射与校验结果,
//         mappedCount, errorCount, errors: 失败原因列表 }。
// 本函数不做任何写入。

function cellName(cell) {
  return (cell && typeof cell.name === 'string' && cell.name.trim()) ? cell.name.trim().slice(0, 50) : '';
}

function planTransfer(sourceReport, targetImage, srcPoints, dstPoints, targetScale) {
  if (!sourceReport || !Array.isArray(sourceReport.cells) || sourceReport.cells.length === 0) {
    throw new Error('来源报告中没有任何细胞，无法迁移');
  }

  const src = parseTriad(srcPoints, '来源', { width: sourceReport.width, height: sourceReport.height });
  const dst = parseTriad(dstPoints, '目标', { width: targetImage.width, height: targetImage.height });

  const affine = solveAffine(src, dst);

  const results = sourceReport.cells.map((cell, i) => {
    const seq = i + 1;
    const name = cellName(cell);
    const label = name ? `来源细胞「${name}」` : `来源第 ${seq} 个细胞`;

    const mappedOuter = cell.outer.map((p) => roundPoint(mapPoint(affine, p)));
    const mappedHoles = (cell.holes || []).map((h) => h.map((p) => roundPoint(mapPoint(affine, p))));

    // 映射后的轮廓必须满足目标图片上的既有几何规则；任一失败记录原因，不影响其他细胞的判定
    let error = null;
    try {
      geo.validateCell({ outer: mappedOuter, holes: mappedHoles, name, _seq: seq },
                       targetImage.width, targetImage.height);
    } catch (e) {
      error = `${label}映射后不合法：${e.message}`;
    }

    let areaUm2 = null;
    let perimeterUm = null;
    if (!error && typeof targetScale === 'number' && Number.isFinite(targetScale) && targetScale > 0) {
      const m = geo.measureCell(mappedOuter, mappedHoles, targetScale);
      areaUm2 = m.areaUm2;
      perimeterUm = m.perimeterUm;
    }

    return {
      sourceIndex: seq,
      sourceCellId: typeof cell.id === 'string' ? cell.id : null,
      name: name || `细胞 ${seq}`,
      holesCount: mappedHoles.length,
      outer: mappedOuter,
      holes: mappedHoles,
      areaUm2,
      perimeterUm,
      valid: !error,
      error
    };
  });

  const errors = results.filter((r) => !r.valid).map((r) => r.error);
  return {
    affine,
    source: {
      reportId: sourceReport.id,
      title: sourceReport.title,
      width: sourceReport.width,
      height: sourceReport.height,
      cellCount: sourceReport.cells.length
    },
    target: {
      imageId: targetImage.id,
      width: targetImage.width,
      height: targetImage.height,
      version: targetImage.version,
      existingCellCount: Array.isArray(targetImage.cells) ? targetImage.cells.length : 0
    },
    srcPoints: src,
    dstPoints: dst,
    cells: results,
    mappedCount: results.length - errors.length,
    errorCount: errors.length,
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  parseTriad,
  solveAffine,
  mapPoint,
  planTransfer,
  roundPoint
};
