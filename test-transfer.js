'use strict';

// 细胞迁移（三点仿射）自测：
//   1) 纯函数层：三点重合/共线、来源无细胞、映射几何校验；
//   2) HTTP 层：上传两张图 → 定标/轮廓/视野 → 发布来源 → 预览 → 版本冲突 → 提交，
//      校验追加语义、新标识不冲突、名称保留、按目标标尺重算、视野统计重算、
//      来源报告与目标原有数据不变。
//
// 运行：node test-transfer.js（需要先 npm install，并使用独立 DATA_DIR，不影响正式数据）

process.env.DATA_DIR = require('path').join(__dirname, 'data-test-transfer');
process.env.PORT = '8123';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const transfer = require('./server/transfer');

let passed = 0;
function ok(name) { passed++; console.log(`ok ${passed} ${name}`); }

// ---------- 纯函数层 ----------

function unitTests() {
  const report = {
    id: 'r1', title: 'R', width: 100, height: 100,
    cells: [
      { id: 'c1', name: '表皮细胞', outer: [{x:10,y:10},{x:90,y:10},{x:90,y:90},{x:10,y:90}], holes: [] }
    ]
  };
  const target = { id: 'i1', width: 100, height: 100, cells: [] };
  const s = [{x:10,y:10},{x:90,y:10},{x:10,y:90}];
  const d = [{x:20,y:20},{x:80,y:20},{x:20,y:80}];

  // 重合点
  assert.throws(() => transfer.planTransfer(report, target,
    [{x:1,y:1},{x:1,y:1},{x:10,y:20}], d), /重合/);
  ok('纯函数：标记点重合被拒绝');

  // 共线
  assert.throws(() => transfer.planTransfer(report, target,
    [{x:0,y:0},{x:10,y:10},{x:20,y:20}], d), /共线/);
  ok('纯函数：三点共线被拒绝');

  // 越界
  assert.throws(() => transfer.planTransfer(report, target, s,
    [{x:-1,y:0},{x:50,y:0},{x:0,y:50}]), /越出图片/);
  ok('纯函数：标记点越界被拒绝');

  // 来源无细胞
  assert.throws(() => transfer.planTransfer(
    { ...report, cells: [] }, target, s, d), /没有任何细胞/);
  ok('纯函数：来源无细胞报错');

  // 映射后越出目标图：目标三点都在图内，但与 (10,10) 对角的第四个矩形顶点落到 (139,139)
  const planBad = transfer.planTransfer(report, target, s,
    [{x:10,y:10},{x:99,y:50},{x:50,y:99}], null);
  assert.strictEqual(planBad.valid, false);
  assert.strictEqual(planBad.cells[0].valid, false);
  assert.match(planBad.cells[0].error, /越出图片|不合法/);
  ok('纯函数：映射越界的细胞逐个标记失败');

  // 合法恒等变换：逐细胞通过、名称保留
  const planOk = transfer.planTransfer(report, { ...target, cells: [{ id: 'old' }] }, s, s, 0.5);
  assert.strictEqual(planOk.valid, true);
  assert.strictEqual(planOk.cells[0].name, '表皮细胞');
  assert.strictEqual(planOk.cells[0].valid, true);
  // 面积：净 6400 px² × 0.25 = 1600 μm²
  assert.ok(Math.abs(planOk.cells[0].areaUm2 - 1600) < 1e-6, planOk.cells[0].areaUm2);
  ok('纯函数：合法映射通过并按目标标尺计算测量');
}

// ---------- HTTP 层 ----------

const BASE = `http://127.0.0.1:${process.env.PORT}`;

async function j(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* noop */ }
  return { status: res.status, body: parsed };
}

async function uploadImage(w, h) {
  const png = await sharp({ create: { width: w, height: h, channels: 3, background: '#202830' } }).png().toBuffer();
  const fd = new FormData();
  fd.append('image', new Blob([png], { type: 'image/png' }), 'slice.png');
  const res = await fetch(`${BASE}/api/images`, { method: 'POST', body: fd });
  if (res.status !== 201) throw new Error(`上传失败 ${res.status} ${await res.text()}`);
  return res.json();
}

async function httpTests() {
  // 准备来源图与目标图
  const srcImg = await uploadImage(200, 200);
  const dstImg = await uploadImage(400, 400);

  // 定标：来源 1px=0.5μm；目标 1px=0.25μm
  let r = await j('PUT', `/api/images/${srcImg.id}/calibration`,
    { version: srcImg.version, p1: {x:0,y:0}, p2:{x:100,y:0}, distanceUm: 50 });
  assert.strictEqual(r.status, 200); const src1 = r.body;
  r = await j('PUT', `/api/images/${dstImg.id}/calibration`,
    { version: dstImg.version, p1: {x:0,y:0}, p2:{x:100,y:0}, distanceUm: 25 });
  assert.strictEqual(r.status, 200); const dst1 = r.body;

  // 来源：一个矩形细胞 + 一个孔洞
  const srcCells = [{
    name: '来源细胞A',
    outer: [{x:20,y:20},{x:180,y:20},{x:180,y:180},{x:20,y:180}],
    holes: [[{x:60,y:60},{x:100,y:60},{x:100,y:100},{x:60,y:100}]]
  }];
  r = await j('PUT', `/api/images/${srcImg.id}/contours`, { version: src1.version, cells: srcCells });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const src2 = r.body;
  const srcCellId = src2.cells[0].id;

  // 目标：一个原有细胞 + 一个覆盖大部分画面的取样视野（迁移细胞质心应落入其中）
  const dstCells = [{
    name: '目标原有细胞',
    outer: [{x:30,y:300},{x:80,y:300},{x:80,y:360},{x:30,y:360}],
    holes: []
  }];
  r = await j('PUT', `/api/images/${dstImg.id}/contours`, { version: dst1.version, cells: dstCells });
  assert.strictEqual(r.status, 200); const dst2 = r.body;
  const oldDstCellId = dst2.cells[0].id;

  r = await j('PUT', `/api/images/${dstImg.id}/fields`, {
    version: dst2.version,
    fields: [{ name: '全片视野', outer: [{x:5,y:5},{x:395,y:5},{x:395,y:395},{x:5,y:395}], holes: [] }]
  });
  assert.strictEqual(r.status, 200); const dst3 = r.body;
  const fieldId = dst3.fields[0].id;
  assert.strictEqual(dst3.fieldStats[0].cellCount, 1); // 迁移前只计入原有细胞

  // 发布来源
  r = await j('POST', `/api/images/${srcImg.id}/publish`, { version: src2.version, title: '来源报告' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const report = r.body.report;
  assert.strictEqual(report.cells.length, 1);

  const s = [{x:20,y:20},{x:180,y:20},{x:20,y:180}];
  // 2 倍放大映射：目标点 (40,40),(360,40),(40,360)
  const dGood = [{x:40,y:40},{x:360,y:40},{x:40,y:360}];
  const payloadPreview = {
    sourceReportId: report.id, targetImageId: dstImg.id,
    sourcePoints: s, targetPoints: dGood
  };

  // 报告不存在 → 404；目标不存在 → 404
  r = await j('POST', '/api/transfers/preview',
    { ...payloadPreview, sourceReportId: '00000000-0000-0000-0000-000000000000' });
  assert.strictEqual(r.status, 404);
  r = await j('POST', '/api/transfers/preview',
    { ...payloadPreview, targetImageId: '00000000-0000-0000-0000-000000000000' });
  assert.strictEqual(r.status, 404);
  ok('HTTP：来源报告/目标不存在明确报 404');

  // 点重合 / 共线 → 400
  r = await j('POST', '/api/transfers/preview',
    { ...payloadPreview, sourcePoints: [{x:1,y:1},{x:1,y:1},{x:20,y:50}] });
  assert.strictEqual(r.status, 400); assert.match(r.body.error, /重合/);
  r = await j('POST', '/api/transfers/preview',
    { ...payloadPreview, targetPoints: [{x:0,y:0},{x:50,y:50},{x:100,y:100}] });
  assert.strictEqual(r.status, 400); assert.match(r.body.error, /共线/);
  ok('HTTP：点重合/共线返回 400 且指出原因');

  // 映射后出界：三点都在目标图内，但外轮廓第四角映射到图外（400px 图外）
  r = await j('POST', '/api/transfers/preview',
    { ...payloadPreview, targetPoints: [{x:40,y:40},{x:396,y:200},{x:200,y:396}] });
  assert.strictEqual(r.status, 400);
  assert.ok(r.body.plan && r.body.plan.valid === false);
  assert.strictEqual(r.body.plan.cells[0].valid, false);
  ok('HTTP：映射轮廓越界 → 400 并回传逐个失败原因，禁止提交');

  // 预览成功：不改变版本与数据
  const versionBefore = dst3.version;
  r = await j('POST', '/api/transfers/preview', payloadPreview);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.targetVersion, versionBefore);
  const plan = r.body.plan;
  assert.strictEqual(plan.valid, true);
  assert.strictEqual(plan.cells.length, 1);
  assert.strictEqual(plan.cells[0].name, '来源细胞A');
  assert.strictEqual(plan.cells[0].holesCount, 1);
  // 映射后外环 (40,40)-(360,360)：净 px = 320² − 80² = 96000；μm² = ×0.25² = 6000
  assert.ok(Math.abs(plan.cells[0].areaUm2 - 6000) < 1e-6, plan.cells[0].areaUm2);
  let check = await j('GET', `/api/images/${dstImg.id}`);
  assert.strictEqual(check.body.version, versionBefore);
  assert.strictEqual(check.body.cells.length, 1); // 预览未写入
  ok('HTTP：预览通过并给出映射图形/逐个结果，且不写入、版本不变');

  // 不带版本提交 → 400
  r = await j('POST', '/api/transfers/commit', payloadPreview);
  assert.strictEqual(r.status, 400);
  ok('HTTP：提交缺少版本号被拒绝');

  // 过期版本 → 409 与当前版本
  r = await j('POST', '/api/transfers/commit', { ...payloadPreview, version: versionBefore - 1 });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.currentVersion, versionBefore);
  check = await j('GET', `/api/images/${dstImg.id}`);
  assert.strictEqual(check.body.cells.length, 1); // 冲突不写入
  ok('HTTP：版本过期返回 409 并提示刷新，整批不写入');

  // 正式提交
  r = await j('POST', '/api/transfers/commit', { ...payloadPreview, version: versionBefore });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.addedCount, 1);
  const after = r.body.image;
  assert.strictEqual(after.version, versionBefore + 1);
  assert.strictEqual(after.cells.length, 2);
  // 目标原有细胞保持不变（id、名称）
  assert.strictEqual(after.cells[0].id, oldDstCellId);
  assert.strictEqual(after.cells[0].name, '目标原有细胞');
  // 新细胞：新标识不冲突、名称保留、按目标标尺重算
  const added = after.cells[1];
  assert.ok(added.id && added.id !== srcCellId && added.id !== oldDstCellId);
  assert.strictEqual(added.name, '来源细胞A');
  assert.ok(Math.abs(added.areaUm2 - 6000) < 1e-6, added.areaUm2);
  assert.strictEqual(added.holes.length, 1);
  // 视野统计已随追加细胞重算：质心 (200,200) 落在全片视野内 → 2 个
  const fsStat = after.fieldStats.find((x) => x.id === fieldId);
  assert.strictEqual(fsStat.cellCount, 2);
  assert.ok(fsStat.countedCellKeys.includes(added.id));
  ok('HTTP：提交成功 → 追加细胞、新标识不冲突、保留名称、按目标标尺重算、视野统计重算');

  // 标尺未改变
  assert.ok(Math.abs(after.calib.scale - 0.25) < 1e-12);
  // 来源报告不变：冻结的还是发布时那一个细胞、旧 id
  const repAfter = (await j('GET', `/api/reports/${report.id}`)).body;
  assert.strictEqual(repAfter.cells.length, 1);
  assert.strictEqual(repAfter.cells[0].id, srcCellId);
  // 来源草稿也未因迁移改变（发布后版本与细胞数保持）
  const srcAfter = (await j('GET', `/api/images/${srcImg.id}`)).body;
  assert.strictEqual(srcAfter.cells.length, 1);
  ok('HTTP：来源报告、来源草稿、目标原有细胞与标尺均未改变');

  // 用同一（已过期）版本再提交一次 → 409
  r = await j('POST', '/api/transfers/commit', { ...payloadPreview, version: versionBefore });
  assert.strictEqual(r.status, 409);
  check = await j('GET', `/api/images/${dstImg.id}`);
  assert.strictEqual(check.body.cells.length, 2); // 没有重复追加
  ok('HTTP：提交一次性消费版本，重复/过期提交不写入');
}

async function main() {
  unitTests();

  // 干净的数据目录；server/index.js 在 require 时即监听 PORT，等待端口就绪后跑 HTTP 用例
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  require('./server/index.js');
  await new Promise((resolve) => setTimeout(resolve, 700));
  await httpTests();
  console.log(`\n全部迁移测试通过（${passed} 项）`);
  process.exit(0);
}

main().catch((e) => {
  console.error('测试失败：', e);
  process.exit(1);
});
