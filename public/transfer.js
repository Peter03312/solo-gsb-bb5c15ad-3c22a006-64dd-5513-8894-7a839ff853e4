'use strict';

// 细胞迁移页：已发布报告（来源）→ 图片草稿（目标），三点仿射。
// 在两张原图上各放置顺序对应的三个点，调用同一后端逻辑完成预览与提交：
// 预览返回映射图形（轮廓点）与逐细胞校验结果；提交携带预览时的目标草稿版本，
// 过期返回 409；任何失败整批不写入。本页不做几何写库，所有裁决以后端为准。

const TR_SRC_COLOR = '#8fa6ae';   // 来源冻结细胞（灰）
const TR_EXIST_COLOR = '#4a90e2'; // 目标原有细胞（蓝）
const TR_MAP_COLOR = '#00e676';   // 映射后合法细胞（绿）
const TR_MAP_BAD = '#ff5d5d';     // 映射后非法细胞（红）
const TR_POINT_SRC = '#ffd400';
const TR_POINT_DST = '#00e5ff';

function trFmt(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v !== 0 && Math.abs(v) < 0.001) return v.toExponential(3);
  return (Math.round(v * 1000) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}

const Transfer = {
  targetId: null,
  reports: [],
  source: null,
  target: null,
  srcPts: [],
  dstPts: [],
  viewSrc: null,
  viewDst: null,
  plan: null,
  targetVersion: null,
  committed: false,

  async open(targetId) {
    this.targetId = targetId || null;
    this.source = null;
    this.target = null;
    this.srcPts = [];
    this.dstPts = [];
    this.plan = null;
    this.targetVersion = null;
    this.committed = false;
    this.showError(null);

    document.getElementById('tr-back').href = this.targetId ? `#/edit/${this.targetId}` : '#/';
    document.getElementById('tr-results').innerHTML = '';
    document.getElementById('tr-summary').textContent = '';
    document.getElementById('tr-commit').disabled = true;

    // 并行：报告列表 + 目标草稿（目标不存在由路由侧 catch 处理）
    const [reports, target] = await Promise.all([
      API.listReports(),
      this.targetId ? API.getImage(this.targetId) : Promise.resolve(null)
    ]);
    this.reports = reports;
    this.target = target;
    this.populateReports();
    this.renderInfo();

    // CanvasView 在同一组 DOM 节点上只创建一次，避免重复进出页面时叠加事件监听
    if (!this.viewSrc) {
      this.viewSrc = this.makeView('tr-canvas-src', 'src', TR_POINT_SRC);
      this.viewDst = this.makeView('tr-canvas-dst', 'dst', TR_POINT_DST);
    }
    this.viewDst.bindState(() => ({ drawing: null }));
    this.viewSrc.bindState(() => ({ drawing: null }));

    if (target) {
      await this.viewDst.loadImage(`/api/images/${target.id}/file`, target.width, target.height);
      document.getElementById('tr-version').textContent =
        `目标草稿 v${target.version} · ${target.filename} · ${target.width}×${target.height}px · 现有细胞 ${target.cells.length} 个`;
    } else {
      document.getElementById('tr-version').textContent = '未指定目标草稿（仅可选择来源预览）';
    }
    this.renderAll();
  },

  populateReports() {
    const sel = document.getElementById('tr-source-report');
    sel.innerHTML = '';
    if (!this.reports.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（还没有已发布报告，请先在编辑页发布）';
      sel.appendChild(opt);
      return;
    }
    this.reports.forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.title} · ${r.filename} · ${r.width}×${r.height}px · 细胞 ${r.cells.length} 个`;
      sel.appendChild(opt);
    });
  },

  async loadSource() {
    const id = document.getElementById('tr-source-report').value;
    if (!id) return this.showError('请先选择一份已发布报告作为来源');
    const report = await API.getReport(id);
    this.source = report;
    // 重新载入来源会使旧的三点与预览失效
    this.srcPts = [];
    this.dstPts = [];
    this.plan = null;
    this.targetVersion = null;
    this.committed = false;
    document.getElementById('tr-commit').disabled = true;
    document.getElementById('tr-results').innerHTML = '';
    document.getElementById('tr-summary').textContent = '';
    this.showError(null);
    await this.viewSrc.loadImage(`/api/reports/${report.id}/file`, report.width, report.height);
    this.renderInfo();
    this.renderAll();
  },

  makeView(canvasId, side, pointColor) {
    const view = new CanvasView(document.getElementById(canvasId), {
      onPoint: (pt) => this.addPoint(side, pt),
      afterRender: (ctx, v) => this.drawOverlay(ctx, v, side, pointColor)
    });
    view.setTool('cell'); // 借用轮廓工具的点击转发；无 drawing，每次单击都产生一个点
    return view;
  },

  addPoint(side, pt) {
    const arr = side === 'src' ? this.srcPts : this.dstPts;
    if (arr.length >= 3) {
      return this.flash(side === 'src' ? '来源点已达 3 个，可撤销后重放' : '目标点已达 3 个，可撤销后重放');
    }
    arr.push({ x: Math.round(pt.x * 100) / 100, y: Math.round(pt.y * 100) / 100 });
    // 改动标记点后，旧预览失效，需要重新预览才能提交
    this.plan = null;
    this.targetVersion = null;
    document.getElementById('tr-commit').disabled = true;
    this.renderAll();
  },

  undo(side) {
    (side === 'src' ? this.srcPts : this.dstPts).pop();
    this.plan = null;
    this.targetVersion = null;
    document.getElementById('tr-commit').disabled = true;
    this.renderAll();
  },

  clear(side) {
    if (side === 'src') this.srcPts = []; else this.dstPts = [];
    this.plan = null;
    this.targetVersion = null;
    document.getElementById('tr-commit').disabled = true;
    this.renderAll();
  },

  // ---------- 预览 ----------

  async preview() {
    if (!this.target) return this.showError('目标图片草稿不存在，无法迁移');
    if (!this.source) return this.showError('请先选择并载入一份已发布报告作为来源');
    if (this.srcPts.length !== 3 || this.dstPts.length !== 3) {
      return this.showError(`请在两张原图上各放满 3 个标记点（当前来源 ${this.srcPts.length}/3、目标 ${this.dstPts.length}/3）`);
    }
    const payload = {
      sourceReportId: this.source.id,
      targetImageId: this.target.id,
      sourcePoints: this.srcPts,
      targetPoints: this.dstPts
    };
    let body;
    try {
      body = await API.transferPreview(payload);
    } catch (e) {
      body = e.body;
      this.showError(e.message);
      // 几何级失败时后端带回逐细胞 plan（点级失败则没有）
      if (body && body.plan) this.acceptPlan(body.plan, null);
      return;
    }
    this.showError(null);
    this.acceptPlan(body.plan, body.targetVersion);
    this.flash(`预览完成：${body.plan.mappedCount}/${body.plan.cells.length} 个细胞映射后通过校验`, true);
  },

  // 写入预览结果（成功或带 plan 的失败）；只有合法 plan 且带版本号才允许提交
  acceptPlan(plan, targetVersion) {
    this.plan = plan;
    this.targetVersion = targetVersion;
    this.committed = false;
    document.getElementById('tr-commit').disabled = !(plan && plan.valid && Number.isInteger(targetVersion));
    this.renderAll();
  },

  // ---------- 提交（携带预览时读取的目标草稿版本） ----------

  async commit() {
    if (!this.plan || !this.plan.valid || !Number.isInteger(this.targetVersion)) {
      return this.showError('请先取得全部细胞通过校验的预览，再确认迁移');
    }
    if (!confirm(`确认把 ${this.plan.cells.length} 个映射细胞追加到目标草稿「${this.target.filename}」？\n` +
                 `将生成新标识、保留名称，并按目标标尺重算测量；来源报告与目标原有数据不变。`)) {
      return;
    }
    let body;
    try {
      body = await API.transferCommit({
        sourceReportId: this.source.id,
        targetImageId: this.target.id,
        sourcePoints: this.srcPts,
        targetPoints: this.dstPts,
        version: this.targetVersion
      });
    } catch (e) {
      if (e.status === 409) {
        // 版本过期：按提示刷新目标草稿，旧预览作废
        this.showError(`${e.message}`);
        try {
          this.target = await API.getImage(this.target.id);
          document.getElementById('tr-version').textContent =
            `目标草稿 v${this.target.version} · ${this.target.filename} · ${this.target.width}×${this.target.height}px · 现有细胞 ${this.target.cells.length} 个`;
        } catch { /* ignore */ }
        this.plan = null;
        this.targetVersion = null;
        document.getElementById('tr-commit').disabled = true;
        this.renderAll();
        return;
      }
      this.showError(e.message);
      if (e.body && e.body.plan) this.acceptPlan(e.body.plan, null);
      return;
    }

    // 成功：以服务端返回的追加后草稿为准；标记点与预览清空，可继续下一次迁移
    this.target = body.image;
    this.plan = null;
    this.targetVersion = null;
    this.dstPts = [];
    this.srcPts = [];
    this.committed = true;
    document.getElementById('tr-commit').disabled = true;
    this.showError(null);
    this.renderAll();
    this.flash(`迁移成功：已追加 ${body.addedCount} 个细胞到目标草稿（v${body.image.version}），原有细胞与标尺未改变`, true);
    document.getElementById('tr-version').textContent =
      `目标草稿 v${body.image.version} · ${this.target.filename} · ${this.target.width}×${this.target.height}px · 现有细胞 ${this.target.cells.length} 个`;
  },

  // ---------- 渲染 ----------

  renderInfo() {
    document.getElementById('tr-src-info').textContent = this.source
      ? `${this.source.title} · ${this.source.width}×${this.source.height}px · 细胞 ${this.source.cells.length} 个`
      : '尚未载入';
    document.getElementById('tr-dst-info').textContent = this.target
      ? `${this.target.filename} · ${this.target.width}×${this.target.height}px · 现有 ${this.target.cells.length} 个`
      : '未指定';
  },

  renderAll() {
    document.getElementById('tr-src-count').textContent = `${this.srcPts.length} / 3`;
    document.getElementById('tr-dst-count').textContent = `${this.dstPts.length} / 3`;
    this.renderInfo();
    if (this.viewSrc) this.viewSrc.render();
    if (this.viewDst) this.viewDst.render();
    this.renderResults();
  },

  drawCells(ctx, view, cells, color, { fillAlpha } = {}) {
    cells.forEach((cell) => {
      view.drawPolygon(ctx, cell.outer, {
        fill: fillAlpha ? color : null,
        stroke: color,
        width: 1.8 / view.k
      });
      (cell.holes || []).forEach((h) => view.drawPolygon(ctx, h, {
        stroke: '#ff1744', dash: [6 / view.k, 4 / view.k], width: 1.4 / view.k, fill: null
      }));
    });
  },

  drawOverlay(ctx, view, side, pointColor) {
    if (side === 'src') {
      if (this.source) this.drawCells(ctx, view, this.source.cells, TR_SRC_COLOR);
      this.drawTriad(ctx, view, this.srcPts, pointColor);
      return;
    }
    // 目标侧：原有细胞 → 映射预览（合法绿/非法红）→ 目标点
    if (this.target) this.drawCells(ctx, view, this.target.cells, TR_EXIST_COLOR, { fillAlpha: true });
    if (this.plan) {
      this.plan.cells.forEach((r) => {
        this.drawCells(ctx, view, [{ outer: r.outer, holes: r.holes }],
          r.valid ? TR_MAP_COLOR : TR_MAP_BAD, { fillAlpha: r.valid });
      });
    }
    this.drawTriad(ctx, view, this.dstPts, pointColor);
  },

  drawTriad(ctx, view, pts, color) {
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (pts.length === 3) ctx.closePath();
      ctx.strokeStyle = color + 'aa';
      ctx.lineWidth = 1.4 / view.k;
      ctx.setLineDash([5 / view.k, 4 / view.k]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    pts.forEach((p, i) => {
      const r = 9 / view.k;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1.5 / view.k;
      ctx.strokeStyle = '#06130f';
      ctx.stroke();
      ctx.fillStyle = '#06130f';
      ctx.font = `bold ${11.5 / view.k}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y + 0.6 / view.k);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    });
  },

  renderResults() {
    const wrap = document.getElementById('tr-results');
    const summary = document.getElementById('tr-summary');
    if (!this.plan) {
      wrap.innerHTML = this.committed
        ? '<p class="hint">迁移已写入。可重新选点继续从其它报告迁移，或返回切片编辑页查看。</p>'
        : '<p class="hint">放好两组三点后点击「预览映射与逐个校验」，这里列出每个细胞的映射结果。</p>';
      if (this.plan === null && !this.committed) summary.textContent = '';
      return;
    }
    const p = this.plan;
    const calibrated = !!(this.target && this.target.calib);
    const sx = Math.hypot(p.affine.a, p.affine.c);
    const sy = Math.hypot(p.affine.b, p.affine.d);
    const rot = Math.atan2(p.affine.c, p.affine.a) * 180 / Math.PI;
    summary.innerHTML =
      `目标草稿 <b>v${p.target.version}</b> · 变换：x 缩放 ${sx.toFixed(4)}、y 缩放 ${sy.toFixed(4)}、` +
      `旋转 ${rot.toFixed(2)}°、面积倍率 ${Math.abs(p.affine.det).toFixed(4)} · ` +
      `通过 <b class="ok">${p.mappedCount}</b> / 失败 <b class="${p.errorCount ? 'bad' : 'ok'}">${p.errorCount}</b>` +
      (calibrated ? '' : ' · 目标未定标，测量值将在定标后自动计算');

    const rows = p.cells.map((r) => `
      <tr>
        <td>${r.sourceIndex}</td>
        <td>${r.name}</td>
        <td>${r.holesCount}</td>
        <td>${trFmt(r.areaUm2)}</td>
        <td>${trFmt(r.perimeterUm)}</td>
        <td class="${r.valid ? 'ok' : 'bad'}">${r.valid ? '✔ 通过' : `✘ ${r.error}`}</td>
      </tr>`).join('');
    wrap.innerHTML = `
      <table class="measure cmp-table">
        <thead><tr>
          <th>来源#</th><th>细胞名称（保留）</th><th>孔洞</th>
          <th>映射后净面积 μm²${calibrated ? '' : '（未定标）'}</th>
          <th>映射后总周长 μm${calibrated ? '' : '（未定标）'}</th>
          <th>逐个校验结果</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="hint">预览与提交使用同一变换及校验；存在失败细胞时<b>禁止提交</b>。
      映射细胞将<b>追加</b>到目标现有细胞，生成不冲突的新标识；来源报告、目标原有细胞与标尺、已发布报告均不改变。</p>`;
  },

  showError(msg) {
    const el = document.getElementById('tr-error');
    if (!msg) {
      el.classList.add('hidden');
      el.textContent = '';
    } else {
      el.classList.remove('hidden');
      el.textContent = msg;
    }
  },

  flashTimer: null,
  flash(msg, ok = false) {
    // 在迁移卡片内临时显示一行；超时后恢复为当前计划的统计摘要
    const el = document.getElementById('tr-summary');
    if (this.flashTimer) clearTimeout(this.flashTimer);
    el.innerHTML = `<span class="${ok ? 'ok' : 'bad'}">${msg}</span>`;
    this.flashTimer = setTimeout(() => this.renderResults(), 3500);
  },

  bindUI() {
    document.getElementById('tr-load').onclick = () => this.loadSource().catch((e) => this.showError(e.message));
    document.getElementById('tr-src-undo').onclick = () => this.undo('src');
    document.getElementById('tr-src-clear').onclick = () => this.clear('src');
    document.getElementById('tr-dst-undo').onclick = () => this.undo('dst');
    document.getElementById('tr-dst-clear').onclick = () => this.clear('dst');
    document.getElementById('tr-preview').onclick = () => this.preview();
    document.getElementById('tr-commit').onclick = () => this.commit();
  }
};

window.Transfer = Transfer;
