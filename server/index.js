'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const { initDb } = require('./db');
const geo = require('./geometry');
const cmp = require('./compare');
const fieldsSvc = require('./fields');
const transfer = require('./transfer');
const { renderAnnotatedPng } = require('./render');
const { buildReportCsv, buildCombinedCsv, buildComparisonCsv, buildFieldStatsCsv, streamZip } = require('./exporter');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PORT = parseInt(process.env.PORT || '8080', 10);
const IMG_DIR = path.join(DATA_DIR, 'images');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');

const db = initDb(DATA_DIR);
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

// ---------- helpers ----------

function getImageOr404(id) {
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
  if (!row) return null;
  return hydrateImage(row);
}

function hydrateImage(row) {
  const calib = row.calib ? JSON.parse(row.calib) : null;
  const cells = JSON.parse(row.cells);
  const fields = JSON.parse(row.fields || '[]');
  return {
    id: row.id,
    filename: row.filename,
    width: row.width,
    height: row.height,
    version: row.version,
    calib,
    cells,
    fields,
    fieldStats: fieldsSvc.buildFieldStats(fields, cells, calib ? calib.scale : null),
    published: !!row.published,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hydrateReport(row) {
  const calib = JSON.parse(row.calib);
  const cells = JSON.parse(row.cells);
  const fields = JSON.parse(row.fields || '[]'); // 旧报告无视野列：按空列表读取
  return {
    id: row.id,
    imageId: row.image_id,
    draftVersion: row.draft_version,
    title: row.title,
    filename: row.filename,
    width: row.width,
    height: row.height,
    calib,
    cells,
    fields,
    fieldStats: fieldsSvc.buildFieldStats(fields, cells, calib ? calib.scale : null),
    createdAt: row.created_at
  };
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

// 校验客户端携带的草稿版本；过期返回 null（调用方回 409）
function checkVersion(img, version) {
  return Number.isInteger(version) && version === img.version;
}

const round3 = (v) => Math.round(v * 1000) / 1000;
function roundPoint(p) { return { x: round3(p.x), y: round3(p.y) }; }

// 重算整份草稿中所有细胞的测量值（未定标时结果为 null）
function recompute(cells, calib) {
  const scale = calib ? calib.scale : null;
  return cells.map((c) => {
    if (scale === null) {
      return { ...c, areaUm2: null, perimeterUm: null };
    }
    const m = geo.measureCell(c.outer, c.holes, scale);
    return { ...c, areaUm2: m.areaUm2, perimeterUm: m.perimeterUm };
  });
}

// ---------- 图片 ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: IMG_DIR,
    filename: (_req, file, cb) => {
      const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[file.mimetype];
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error('仅支持 PNG / JPEG / WebP 格式的图片'));
    }
    cb(null, true);
  }
});

app.get('/api/images', (_req, res) => {
  const rows = db.prepare('SELECT * FROM images ORDER BY created_at DESC').all();
  res.json(rows.map(hydrateImage));
});

app.post('/api/images', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return badRequest(res, err.message);
    if (!req.file) return badRequest(res, '缺少上传文件（字段名须为 image）');
    const filePath = path.join(IMG_DIR, req.file.filename);
    let meta;
    try {
      meta = await sharp(filePath).metadata();
    } catch {
      fs.rmSync(filePath, { force: true });
      return badRequest(res, '图片文件已损坏或格式无法识别');
    }
    if (!meta.width || !meta.height) {
      fs.rmSync(filePath, { force: true });
      return badRequest(res, '无法读取图片尺寸');
    }
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO images (id, filename, stored_name, mime, width, height)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, req.file.originalname, req.file.filename, req.file.mimetype, meta.width, meta.height);
    res.status(201).json(getImageOr404(id));
  });
});

app.get('/api/images/:id', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  res.json(img);
});

app.get('/api/images/:id/file', (req, res) => {
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '图片不存在' });
  res.sendFile(path.join(IMG_DIR, row.stored_name));
});

// ---------- 定标 ----------

app.put('/api/images/:id/calibration', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `草稿已过期：你携带的版本为 ${req.body.version}，当前版本为 ${img.version}，请刷新后重试`, currentVersion: img.version });
  }

  const { p1, p2, distanceUm } = req.body || {};
  const numErr = (m) => badRequest(res, m);
  if (!p1 || !p2 || typeof p1.x !== 'number' || typeof p1.y !== 'number' ||
      typeof p2.x !== 'number' || typeof p2.y !== 'number' ||
      !Number.isFinite(p1.x) || !Number.isFinite(p1.y) ||
      !Number.isFinite(p2.x) || !Number.isFinite(p2.y)) {
    return numErr('标尺无效：必须在原图上选择两个像素点 p1、p2（坐标 {x, y}）');
  }
  if (p1.x < 0 || p1.y < 0 || p2.x < 0 || p2.y < 0 ||
      p1.x > img.width || p1.y > img.height || p2.x > img.width || p2.y > img.height) {
    return numErr(`标尺无效：定标点越出图片范围（图片尺寸 ${img.width}×${img.height} 像素）`);
  }
  const pxDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (pxDist < 1) {
    return numErr('标尺无效：两个定标点必须是不同的像素点（间距至少 1 像素）');
  }
  const dist = Number(distanceUm);
  if (!Number.isFinite(dist) || dist <= 0) {
    return numErr('标尺无效：实际距离必须是大于 0 的数值（微米）');
  }

  const calib = {
    p1: roundPoint(p1), p2: roundPoint(p2),
    distanceUm: dist,
    scale: dist / pxDist // μm / px
  };

  // 重新定标：草稿中的全部测量按新比例重算
  const cells = recompute(img.cells, calib);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE images SET calib = ?, cells = ?, version = version + 1,
                updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(calib), JSON.stringify(cells), img.id);
  });
  tx();
  res.json(getImageOr404(img.id));
});

// ---------- 轮廓（整批替换，任一对象非法则整次修改不生效） ----------

app.put('/api/images/:id/contours', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `草稿已过期：你携带的版本为 ${req.body.version}，当前版本为 ${img.version}，请刷新后重试`, currentVersion: img.version });
  }

  const rawCells = req.body.cells;
  if (!Array.isArray(rawCells)) return badRequest(res, '轮廓数据无效：cells 必须是数组');

  let next;
  try {
    // 先全部校验，任何一个细胞/孔洞失败都会抛出，数据库不发生任何写入
    next = rawCells.map((c, i) => {
      if (!c || typeof c !== 'object') throw new Error(`第 ${i + 1} 个细胞数据格式错误`);
      const { outer, holes } = geo.validateCell({ ...c, _seq: i + 1 }, img.width, img.height);
      const name = typeof c.name === 'string' ? c.name.trim().slice(0, 50) : '';
      return {
        id: typeof c.id === 'string' && c.id ? c.id : crypto.randomUUID(),
        name,
        outer: outer.map(roundPoint),
        holes: holes.map((h) => h.map(roundPoint))
      };
    });
  } catch (e) {
    return badRequest(res, e.message);
  }

  next = recompute(next, img.calib);

  db.prepare(`UPDATE images SET cells = ?, version = version + 1,
              updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(next), img.id);
  res.json(getImageOr404(img.id));
});

// ---------- 取样视野（整批替换，任一视野非法则整次修改不生效） ----------

const MAX_FIELDS = 200;

app.put('/api/images/:id/fields', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `草稿已过期：你携带的版本为 ${req.body.version}，当前版本为 ${img.version}，请刷新后重试`, currentVersion: img.version });
  }

  const rawFields = req.body.fields;
  if (!Array.isArray(rawFields)) return badRequest(res, '视野数据无效：fields 必须是数组');
  if (rawFields.length > MAX_FIELDS) return badRequest(res, `视野数据无效：单张图片最多 ${MAX_FIELDS} 个视野`);

  let next;
  try {
    // 先全部校验：越界/自交/孔洞不严格在内或互相接触重叠/净面积非正都会抛出，数据库不写入
    next = rawFields.map((f, i) => {
      if (!f || typeof f !== 'object') throw new Error(`第 ${i + 1} 个视野数据格式错误`);
      const { outer, holes } = geo.validateField(f, img.width, img.height, i + 1);
      const name = typeof f.name === 'string' ? f.name.trim().slice(0, 50) : '';
      return {
        id: typeof f.id === 'string' && f.id ? f.id : crypto.randomUUID(),
        name,
        outer: outer.map(roundPoint),
        holes: holes.map((h) => h.map(roundPoint))
      };
    });
  } catch (e) {
    return badRequest(res, e.message);
  }

  db.prepare(`UPDATE images SET fields = ?, version = version + 1,
              updated_at = datetime('now') WHERE id = ?`)
    .run(JSON.stringify(next), img.id);
  res.json(getImageOr404(img.id));
});

// ---------- 发布（乐观并发：携带读取时草稿版本） ----------

app.post('/api/images/:id/publish', (req, res) => {
  const img = getImageOr404(req.params.id);
  if (!img) return res.status(404).json({ error: '图片不存在' });
  if (!checkVersion(img, req.body.version)) {
    return res.status(409).json({ error: `发布被拒绝：草稿已过期（携带版本 ${req.body.version}，当前版本 ${img.version}）。请重新读取最新草稿后再发布`, currentVersion: img.version });
  }
  if (!img.calib) return badRequest(res, '尚不能发布：请先完成标尺定标');
  if (img.cells.length === 0) return badRequest(res, '尚不能发布：请至少圈出一个细胞外轮廓');
  for (const c of img.cells) {
    if (typeof c.areaUm2 !== 'number') return badRequest(res, '尚不能发布：存在未按当前标尺计算测量值的轮廓，请重新保存轮廓');
  }

  const reportId = crypto.randomUUID();
  const title = (typeof req.body.title === 'string' && req.body.title.trim())
    ? req.body.title.trim().slice(0, 100)
    : `${img.filename.replace(/\.[^.]+$/, '')} 报告 ${new Date().toISOString().slice(0, 10)}`;

  const srcRow = db.prepare('SELECT stored_name FROM images WHERE id = ?').get(img.id);
  const snapExt = path.extname(srcRow.stored_name);
  const snapName = `${reportId}${snapExt}`;
  // 先固化图片快照：报告永远保留发布当时的图片文件
  fs.copyFileSync(path.join(IMG_DIR, srcRow.stored_name), path.join(SNAP_DIR, snapName));

  try {
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO reports
                  (id, image_id, draft_version, title, filename, snapshot_name, width, height, calib, cells, fields)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(reportId, img.id, img.version, title, img.filename, snapName,
             img.width, img.height, JSON.stringify(img.calib), JSON.stringify(img.cells),
             JSON.stringify(img.fields || []));
      db.prepare(`UPDATE images SET published = 1, version = version + 1,
                  updated_at = datetime('now') WHERE id = ?`).run(img.id);
    });
    tx();
  } catch (e) {
    fs.rmSync(path.join(SNAP_DIR, snapName), { force: true });
    throw e;
  }

  res.status(201).json({
    report: hydrateReport(db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId)),
    image: getImageOr404(img.id)
  });
});

// ---------- 细胞迁移（已发布报告 → 图片草稿，三点仿射；预览与提交同一变换及校验） ----------

// 组装迁移请求：校验来源报告与目标草稿存在、来源有细胞、两组三点合法、
// 映射后全部轮廓通过既有几何规则。任一失败抛出 Error（message 已可直接展示）。
// 返回 { report, img, plan }；不做任何写入。
function resolveTransferPlan(body) {
  const reportId = body && body.sourceReportId;
  const targetId = body && body.targetImageId;
  if (typeof reportId !== 'string' || !reportId) {
    throw Object.assign(new Error('请选择一份已发布报告作为来源 sourceReportId'), { status: 400 });
  }
  if (typeof targetId !== 'string' || !targetId) {
    throw Object.assign(new Error('请选择一张图片草稿作为目标 targetImageId'), { status: 400 });
  }
  const report = getReportOr404(reportId);
  if (!report) throw Object.assign(new Error(`来源报告 ${reportId} 不存在`), { status: 404 });
  const img = getImageOr404(targetId);
  if (!img) throw Object.assign(new Error(`目标图片草稿 ${targetId} 不存在`), { status: 404 });
  if (!report.cells.length) {
    throw Object.assign(new Error(`来源报告「${report.title}」中没有任何细胞，无法迁移`), { status: 400 });
  }

  // planTransfer 内部解析/校验两组三点并逐细胞复算几何规则；点重合、共线、越界、
  // 映射后轮廓不合法都会在此抛出，整个请求不会写入任何数据。
  const plan = transfer.planTransfer(
    report, img, body.sourcePoints, body.targetPoints,
    img.calib ? img.calib.scale : null
  );
  if (!plan.valid) {
    throw Object.assign(
      new Error(`映射校验未通过，禁止迁移（整批不写入）：${plan.errors.join('；')}`),
      { status: 400, plan }
    );
  }
  return { report, img, plan };
}

// 预览：返回映射图形（轮廓点）与逐个细胞校验结果，不改变任何数据
app.post('/api/transfers/preview', (req, res) => {
  let resolved;
  try {
    resolved = resolveTransferPlan(req.body || {});
  } catch (e) {
    const status = e.status || 400;
    return res.status(status).json({
      error: e.message,
      // 点/轮廓校验失败时仍带回逐细胞结果，便于页面展示每个细胞的失败原因
      ...(e.plan ? { plan: e.plan } : {})
    });
  }
  const { plan, img } = resolved;
  res.json({
    ok: true,
    targetVersion: img.version, // 提交时必须原样带回
    plan
  });
});

// 提交：必须携带预览时读取的目标草稿版本；版本过期 → 409，整批不写入。
// 成功后映射细胞【追加】到目标现有细胞：生成不冲突的新标识、保留名称、
// 按目标标尺重算测量；视野统计随水合结果自动重算。
app.post('/api/transfers/commit', (req, res) => {
  const body = req.body || {};

  const targetId = body.targetImageId;
  if (typeof targetId !== 'string' || !targetId) {
    return badRequest(res, '请选择目标图片草稿 targetImageId');
  }
  const img0 = getImageOr404(targetId);
  if (!img0) return res.status(404).json({ error: `目标图片草稿 ${targetId} 不存在` });
  if (!Number.isInteger(body.version)) {
    return badRequest(res, '确认迁移必须携带预览时读取的目标草稿版本号 version');
  }
  if (body.version !== img0.version) {
    return res.status(409).json({
      error: `迁移被拒绝：目标草稿已过期（携带版本 v${body.version}，当前版本 v${img0.version}）。请刷新预览、重新确认后再提交`,
      currentVersion: img0.version
    });
  }

  // 用与预览完全相同的输入重算同一变换与校验（任何失败整批不写入）
  let resolved;
  try {
    resolved = resolveTransferPlan(body);
  } catch (e) {
    const status = e.status || 400;
    return res.status(status).json({
      error: e.message,
      ...(e.plan ? { plan: e.plan } : {})
    });
  }
  const { plan } = resolved;

  // 生成不与目标现有细胞（及本批新细胞）冲突的新标识；名称保留来源名称
  const usedIds = new Set(img0.cells.map((c) => c.id).filter(Boolean));
  const newCells = plan.cells.map((r) => {
    let id = crypto.randomUUID();
    while (usedIds.has(id)) id = crypto.randomUUID();
    usedIds.add(id);
    return {
      id,
      name: r.name,
      outer: r.outer,
      holes: r.holes,
      areaUm2: r.areaUm2,       // 已按目标标尺计算；目标未定标则为 null
      perimeterUm: r.perimeterUm
    };
  });

  const merged = img0.cells.concat(newCells);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE images SET cells = ?, version = version + 1,
                updated_at = datetime('now') WHERE id = ? AND version = ?`)
      .run(JSON.stringify(merged), img0.id, img0.version);
  });
  tx();

  const updated = getImageOr404(img0.id);
  res.status(201).json({
    ok: true,
    addedCount: newCells.length,
    // 仅返回本次追加细胞的服务端视图（含新标识与按目标标尺重算的测量）
    addedCells: updated.cells.slice(updated.cells.length - newCells.length),
    image: updated // 追加后的整份目标草稿（含实时重算的 fieldStats）
  });
});

// ---------- 报告 ----------

app.get('/api/reports', (_req, res) => {
  const rows = db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
  res.json(rows.map(hydrateReport));
});

function getReportOr404(id) {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  return row ? hydrateReport(row) : null;
}

app.get('/api/reports/:id', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  res.json(report);
});

app.get('/api/reports/:id/file', (req, res) => {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '报告不存在' });
  res.sendFile(path.join(SNAP_DIR, row.snapshot_name));
});

app.get('/api/reports/:id/png', async (req, res) => {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '报告不存在' });
  try {
    const buf = await renderAnnotatedPng(path.join(SNAP_DIR, row.snapshot_name), {
      width: row.width, height: row.height,
      calib: JSON.parse(row.calib), cells: JSON.parse(row.cells)
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${row.id}_annotated.png"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: `标注图片生成失败：${e.message}` });
  }
});

app.get('/api/reports/:id/csv', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${report.id}_measurements.csv"`);
  res.send(buildReportCsv(report));
});

// 视野统计 CSV：与报告页显示同一份冻结结果（旧报告视野为空 → 仅表头）
app.get('/api/reports/:id/field-csv', (req, res) => {
  const report = getReportOr404(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${report.id}_fields.csv"`);
  res.send(buildFieldStatsCsv(report));
});

// 多份选定报告导出：{ ids: string[], format: 'csv' | 'png' | 'zip' }
app.post('/api/reports/export', async (req, res) => {
  const { ids, format } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return badRequest(res, '请至少选择一份报告');
  const reports = [];
  for (const id of ids.slice(0, 50)) {
    const r = getReportOr404(id);
    if (!r) return badRequest(res, `报告 ${id} 不存在或已被删除`);
    reports.push(r);
  }

  try {
    if (format === 'csv') {
      if (reports.length === 1) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${reports[0].id}_measurements.csv"`);
        return res.send(buildReportCsv(reports[0]));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="measurements_combined.csv"');
      return res.send(buildCombinedCsv(reports));
    }

    if (format === 'png') {
      if (reports.length !== 1) return badRequest(res, 'PNG 导出仅支持单份报告，多份请选择 ZIP');
      const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(reports[0].id);
      const buf = await renderAnnotatedPng(path.join(SNAP_DIR, row.snapshot_name), reports[0]);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `attachment; filename="${reports[0].id}_annotated.png"`);
      return res.send(buf);
    }

    if (format === 'zip') {
      const pngByName = {};
      for (const r of reports) {
        const row = db.prepare('SELECT snapshot_name FROM reports WHERE id = ?').get(r.id);
        pngByName[r.id] = await renderAnnotatedPng(path.join(SNAP_DIR, row.snapshot_name), r);
      }
      return streamZip(reports, pngByName, res);
    }

    return badRequest(res, "format 必须是 'csv'、'png' 或 'zip'");
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: `导出失败：${e.message}` });
  }
});

// ---------- 报告比较（两份不同报告的冻结数据，手动一对一配对） ----------

function hydrateComparisonRow(row) {
  return {
    id: row.id,
    title: row.title,
    baselineReportId: row.baseline_report_id,
    retestReportId: row.retest_report_id,
    pairs: JSON.parse(row.pairs),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getComparisonOr404(id) {
  const row = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(id);
  return row ? hydrateComparisonRow(row) : null;
}

// 组装比较结果视图；记录引用的报告若已被删除则返回 null
function getComparisonViewOr404(id) {
  const record = getComparisonOr404(id);
  if (!record) return null;
  const baseline = getReportOr404(record.baselineReportId);
  const retest = getReportOr404(record.retestReportId);
  if (!baseline || !retest) return { missing: true, record };
  return cmp.buildComparisonView(record, baseline, retest);
}

app.get('/api/comparisons', (_req, res) => {
  const rows = db.prepare('SELECT * FROM comparisons ORDER BY created_at DESC').all();
  res.json(rows.map((r) => cmp.summarizeRecord(hydrateComparisonRow(r))));
});

// 读取两报告并校验：报告存在、两侧不同、配对合法。任一不满足返回 {error, status}
function resolveComparisonInput(body) {
  const baselineId = body && body.baselineReportId;
  const retestId = body && body.retestReportId;
  if (typeof baselineId !== 'string' || !baselineId ||
      typeof retestId !== 'string' || !retestId) {
    return { error: '请分别选择基线报告 baselineReportId 与复测报告 retestReportId', status: 400 };
  }
  const baseline = getReportOr404(baselineId);
  if (!baseline) return { error: `基线报告 ${baselineId} 不存在`, status: 400 };
  const retest = getReportOr404(retestId);
  if (!retest) return { error: `复测报告 ${retestId} 不存在`, status: 400 };
  if (baselineId === retestId) return { error: '基线与复测必须选择两份不同的报告，整次保存未生效', status: 400 };

  let checked;
  try {
    checked = cmp.validatePairing(body.pairs, baseline, retest);
  } catch (e) {
    return { error: `${e.message}，整次保存未生效`, status: 400 };
  }
  return { baseline, retest, pairs: checked.pairs };
}

function comparisonTitle(input, baseline, retest) {
  const t = typeof input === 'string' ? input.trim() : '';
  if (t) return t.slice(0, 100);
  return `比较：${baseline.title} ↔ ${retest.title}`.slice(0, 100);
}

app.post('/api/comparisons', (req, res) => {
  const input = resolveComparisonInput(req.body || {});
  if (input.error) return res.status(input.status).json({ error: input.error });
  const { baseline, retest, pairs } = input;

  const id = crypto.randomUUID();
  const title = comparisonTitle(req.body.title, baseline, retest);
  // 全部校验通过后才写库：报告不存在/两侧相同/配对重复/细胞不存在时不会有任何写入
  db.prepare(`INSERT INTO comparisons
              (id, title, baseline_report_id, retest_report_id, pairs)
              VALUES (?, ?, ?, ?, ?)`)
    .run(id, title, baseline.id, retest.id, JSON.stringify(pairs));

  const view = cmp.buildComparisonView(getComparisonOr404(id), baseline, retest);
  res.status(201).json(view);
});

app.get('/api/comparisons/:id', (req, res) => {
  const view = getComparisonViewOr404(req.params.id);
  if (!view) return res.status(404).json({ error: '比较记录不存在' });
  if (view.missing) {
    return res.status(410).json({ error: '该比较记录引用的基线或复测报告已被删除，无法重建比较结果' });
  }
  res.json(view);
});

// 修改比较记录：必须携带读取时版本；过期返回 409 与当前版本，整次修改不生效
app.put('/api/comparisons/:id', (req, res) => {
  const record = getComparisonOr404(req.params.id);
  if (!record) return res.status(404).json({ error: '比较记录不存在' });

  const version = req.body && req.body.version;
  if (!Number.isInteger(version)) {
    return badRequest(res, '修改比较记录必须携带读取时版本号 version');
  }
  if (version !== record.version) {
    return res.status(409).json({
      error: `比较记录已过期：你携带的版本为 v${version}，当前版本为 v${record.version}，请重新读取后再修改`,
      currentVersion: record.version
    });
  }

  // 两侧报告沿用创建时选择的报告；只允许改标题与配对
  const baseline = getReportOr404(record.baselineReportId);
  const retest = getReportOr404(record.retestReportId);
  if (!baseline || !retest) {
    return res.status(410).json({ error: '该比较记录引用的基线或复测报告已被删除，无法修改' });
  }

  let checked;
  try {
    checked = cmp.validatePairing(req.body && req.body.pairs, baseline, retest);
  } catch (e) {
    return badRequest(res, `${e.message}，整次修改未生效`);
  }

  const title = (req.body && typeof req.body.title === 'string' && req.body.title.trim())
    ? req.body.title.trim().slice(0, 100)
    : record.title;

  db.prepare(`UPDATE comparisons SET title = ?, pairs = ?, version = version + 1,
              updated_at = datetime('now') WHERE id = ? AND version = ?`)
    .run(title, JSON.stringify(checked.pairs), record.id, record.version);

  res.json(cmp.buildComparisonView(getComparisonOr404(record.id), baseline, retest));
});

app.get('/api/comparisons/:id/csv', (req, res) => {
  const view = getComparisonViewOr404(req.params.id);
  if (!view) return res.status(404).json({ error: '比较记录不存在' });
  if (view.missing) {
    return res.status(410).json({ error: '该比较记录引用的基线或复测报告已被删除，无法导出' });
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${view.id}_comparison.csv"`);
  res.send(buildComparisonCsv(view));
});

app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));

app.listen(PORT, () => {
  console.log(`PhytoMeasure 已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
});
