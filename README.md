# 🌿 PhytoMeasure · 植物显微切片测量 Web 应用

在浏览器中上传植物显微切片图片，完成像素—微米定标后，圈选多个细胞的外轮廓及其孔洞，
自动计算**扣除孔洞后的净面积（μm²）**与**含孔洞边界的总周长（μm）**；
还可圈定多个**命名取样视野**（外环 + 可选孔洞），按细胞净区域质心统计各视野的
**细胞数、净面积（mm²）与每 mm² 细胞密度**；
并可发布为不可变报告、导出**标注 PNG**、**测量 CSV** 与**视野统计 CSV**。

- 技术栈：Node.js（Express）+ SQLite（better-sqlite3）+ 原生 Canvas 前端
- 图片与数据**全部本地保存**（无任何外部服务依赖）：
  - 数据库：`data/app.db`
  - 原始图片：`data/images/`
  - 发布时的图片快照：`data/snapshots/`
  - 标注 PNG / CSV 在导出时实时生成

## 功能说明

1. **图片上传**：支持 PNG / JPEG / WebP（≤ 30 MB），读取真实像素尺寸。
2. **标尺定标**：在原图上点选**两个不同的像素点**，输入它们的实际微米距离，
   得到每像素微米数（μm/px）。两点重合、坐标越界、距离非正数均会被拒绝，且整次修改不生效。
3. **细胞轮廓**：可圈选多个细胞外轮廓，每个细胞可包含多个孔洞。
   - 轮廓不得**自交/自接触**，顶点不得**越出图片**；
   - 孔洞必须**严格位于**所属外轮廓内部（不能贴着外轮廓边界）；
   - 同一细胞的孔洞之间**不得接触或重叠**；
   - 任意一个对象不合法时，服务端会指出具体细胞/孔洞编号与原因，**整批轮廓保存不生效**。
4. **测量结果**：
   - 净面积 =（外轮廓面积 − 全部孔洞面积）× (μm/px)²，单位 **μm²**；
   - 总周长 =（外轮廓周长 + 全部孔洞周长）× μm/px，单位 **μm**；
   - 缩放、平移视图只改变显示，不改变任何测量值。
5. **重新定标**：草稿中的所有轮廓立即按新比例重算测量值，所有视野统计同步重算。
6. **取样视野 · 细胞密度统计**：可在同一张切片上圈定**多个命名视野**，每个视野由
   一个不自交外环与**可选孔洞**构成（孔洞必须严格位于外环内、彼此不得接触或重叠）。
   - 归属规则：以每个细胞**扣除孔洞后的净区域质心**判定——质心**严格**落在某视野净区域
     （严格在外环内、且不在视野孔洞内/边界上）才计入；落在**边界不计入**；
   - 视野之间**允许重叠**，重叠处的细胞在每个视野中**分别计数（可重复计数）**；
   - **净面积为零的细胞**没有良定义质心，不计入任何视野；
   - **已定标**时展示各视野：净面积（**mm²**）、细胞数、**每 mm² 细胞密度**、
     计入细胞的净面积总和（mm²）；**未定标**时保留视野与细胞数，面积/密度/总和显示
     **「待定标」**；
   - 细胞轮廓变动、视野变动或重新定标后统计**自动重算**；
   - 整批原子保存：视野越界、自交、孔洞不严格位于外环内或彼此接触重叠、净面积非正时
     **整批视野保存不生效**，服务端指出具体视野编号与原因；
   - 视野保存同样走草稿乐观版本号，版本过期返回 HTTP 409，页面自动拉取最新草稿。
7. **发布与乐观并发**：
   - 发布会冻结当时的**图片副本、标尺、细胞轮廓、取样视野与全部统计结果**（含视野密度统计），
     之后修改草稿（含删除/重画视野）不影响已发布报告；
   - 发布请求必须携带**读取时的草稿版本号**；期间草稿被改动（版本过期）时请求被拒绝（HTTP 409），
     页面会自动拉取最新草稿，需确认后重新发布。
8. **导出**：在「已发布报告」页勾选报告，可导出
   - 单份或多份合并的**测量 CSV**（UTF-8 BOM，Excel 直接可读，含义保持不变）；
   - 单份报告的**视野统计 CSV**（与报告页表格为**同一份冻结结果**；旧报告无视野时仅表头+空提示）；
   - 单份**标注 PNG**（彩色细胞轮廓、红色虚线孔洞、细胞编号与青色标尺）；
   - 多份报告的 **ZIP**（每份一张标注 PNG + 一份 CSV，外附汇总 CSV）。
9. **报告比较（基线 ↔ 复测）**：在「报告比较」页选择**两份不同**的已发布报告，
   先点基线侧一个细胞、再点复测侧一个细胞，**手动**建立一对一配对
   （**同名细胞不会自动配对**；已配对细胞从两侧待选列表移除，可随时「解除」）。
   - 比较只读取两份报告**冻结的定标与测量值**：每对细胞给出净面积、总周长的
     **两侧数值、带符号差值（复测 − 基线）与相对基线变化率**；未配对细胞在两侧分别列出。
   - 基线值为 **0** 时变化率显示 / 导出为 **「不可计算」**（差值仍给出）。
   - 保存校验整批原子生效：**报告不存在、两侧相同、配对重复（同一细胞出现多次）、
     细胞不存在**任一种情况都会被拒绝，**整次保存不生效**。
   - 修改比较记录必须携带**读取时版本号**；期间被他人改动（版本过期）时返回 HTTP 409
     与当前版本，页面自动加载最新版本，过期修改不写入。
   - 可导出与页面分区、数值完全一致的**比较 CSV**（UTF-8 BOM）。
   - 比较记录保存后即与草稿、后续发布解耦：**草稿后续改动或另发新报告都不改变已存比较**；
     比较记录创建时选定的两份报告不可更换。
10. **细胞迁移（已发布报告 → 图片草稿，三点仿射）**：在切片编辑页「⑦ 从已发布报告迁移细胞」
    打开迁移页，选一份**已发布报告**作来源、**当前图片草稿**作目标，在**两张原图**上依次放置
    **顺序对应的三个点**（两侧各 3 个，标记 1/2/3）：
    - 三点必须**互不重合、不共线、不越出各自图片**，否则立即指出原因，预览/提交均被拒绝；
    - 预览把来源报告**全部细胞外轮廓及孔洞**经**唯一仿射变换**映射到目标图，
      绿色显示合法细胞、红色显示非法细胞，并给出**逐个校验结果**（越界 / 自交 / 孔洞不严格在内 /
      孔洞互相接触等任一既有几何规则不满足都按细胞列出原因）；
    - **任一轮廓不合法都禁止提交**；来源报告无细胞、报告或目标不存在也会明确报错；
      **任何失败整批不写入**；
    - 确认迁移必须携带**预览时读取的目标草稿版本号**；期间目标被改动（版本过期）→
      **HTTP 409** 拒绝写入并提示刷新，需要重新预览；
    - 成功后映射细胞**追加到目标现有细胞之后**：生成**不冲突的新标识**、**保留细胞名称**、
      按**目标标尺**重算净面积/总周长（未定标则为 `null`，定标后自动计算），
      **取样视野统计按追加后的细胞集合自动重算**；
    - **来源报告、来源/目标原有细胞与目标标尺、其它已发布报告均不改变**；
    - 预览与提交在服务端走**同一个 `planTransfer`**（同一变换、同一校验），保证“所见即所写”；
    - 既有轮廓保存与发布接口的语义、状态码与乐观并发规则保持不变。

## 配置项

本轮（细胞迁移 / 三点仿射）**未引入新的环境变量、新的数据库表或新的外部依赖**，沿用既有配置；
迁移不落库任何中间状态，只在提交成功后向目标草稿的 `images.cells` **追加**细胞并使 `version + 1`。
启动时自动建表；**旧版本数据库会在启动时幂等补列**（`ALTER TABLE ... ADD COLUMN`），
**旧报告缺少视野列时按空列表读取**，无需手动迁移。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 容器/服务监听端口 |
| `DATA_DIR` | `./data`（Docker 中为 `/app/data`） | SQLite、原始图片、快照的保存目录（比较记录同在 `app.db` 内） |
| `HOST_PORT` | `8080` | 仅 Compose 使用：宿主机映射端口 |

## 一条命令启动（Docker Compose）

```bash
docker compose up -d --build
```

启动后浏览器访问：

```
http://localhost:8080
```

若 8080 端口被占用：

```bash
HOST_PORT=8088 docker compose up -d --build
# 然后访问 http://localhost:8088
```

数据持久化在 Docker 命名卷 `phytomeasure-data` 中。
若希望直接在宿主机目录查看数据，可把 `docker-compose.yml` 中的卷改为绑定挂载：

```yaml
volumes:
  - ./data:/app/data
```

停止与查看日志：

```bash
docker compose down
docker compose logs -f
```

## 非 Docker 方式运行（需 Node.js ≥ 20）

```bash
npm install
npm start
# 访问 http://localhost:8080
```

## 使用步骤（网页操作）

1. 首页上传图片，自动进入编辑器；
2. 选择 **📏 定标点工具**，在图上单击两个点，在弹窗中输入实际距离（μm）；
3. 选择 **⭕ 画细胞外轮廓**：单击逐个加点，双击（或回车）闭合；
4. 在细胞列表中选中某个细胞，用 **🕓 为选中细胞画孔洞** 工具绘制其孔洞；
5. 点击 **保存全部轮廓**——若有非法轮廓/孔洞，顶部红条会指出具体对象，本次保存整体不生效；
6. 右侧测量表实时显示净面积与总周长，滚轮缩放、拖拽平移不影响数值；
7. 在 **③ 取样视野（细胞密度）** 面板选择 **🔲 画取样视野**，像画细胞一样圈出外环并
   **双击/回车**完成；在视野列表选中视野后可用 **🕓 为选中视野画孔洞**；可随时改名/删除；
8. 点击 **保存全部视野**——越界、自交、孔洞不严格位于外环内或互相接触重叠、净面积非正
   都会被拒绝并指出具体视野，整批不生效；保存后（及细胞轮廓变动/重定标后）
   **⑤ 视野细胞密度统计** 自动给出各视野净面积 mm²、细胞数、每 mm² 细胞密度与计入净面积总和；
   未定标时面积/密度显示「待定标」，细胞数仍可查看；
9. 点击 **发布当前草稿为报告**，在「已发布报告」中查看冻结快照，
   报告页展示与「视野统计 CSV」完全一致的冻结视野统计，并可导出 PNG / 测量 CSV / 视野统计 CSV；
10. 需要对比两份报告时，进入 **报告比较**（流程不变，比较仍只读取冻结的细胞测量值）；
11. 需要把另一份切片报告里的细胞搬到当前图片时，在编辑页打开
    **⑦ 从已发布报告迁移细胞（三点仿射）**：
    - 顶部下拉选择**来源已发布报告**并「载入来源与目标原图」；
    - 在**左（来源）**图上依次点击 3 个点，再在**右（目标/当前草稿）**图上依次点击
      **顺序对应**的 3 个点（点上标有 1/2/3，可用「撤销/清空」调整）；
    - 点击 **预览映射与逐个校验**：右侧原图上叠加显示映射后的外轮廓与孔洞——
      **绿色=通过、红色=不合法**；下方表格逐细胞列出孔洞数、按目标标尺的净面积/周长与校验结果；
    - 只有**全部细胞通过**且预览版本仍为最新时，**确认迁移**按钮才可点击；
      若提示 **409 草稿过期**，页面会自动刷新目标，请重新预览后再提交；
    - 成功后映射细胞被追加到本图，返回编辑页即可在细胞列表与视野统计中看到结果，
      来源报告与本图原有轮廓/标尺均不改变。

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server/
│   ├── index.js       # Express API：上传/定标/轮廓/视野/发布/导出/报告比较/细胞迁移
│   ├── db.js          # SQLite 表结构与初始化（启动自动建表 + 旧库幂等补 fields 列）
│   ├── geometry.js    # 几何校验、面积/周长、净区域质心（服务端最终校验）
│   ├── fields.js      # 取样视野：质心归属、mm²/密度统计、未定标“待定标”
│   ├── transfer.js    # 三点仿射迁移：点三元组校验、求解变换、映射与逐细胞校验（预览/提交共用）
│   ├── compare.js     # 报告比较：手动一对一配对校验、冻结值差值/变化率视图
│   ├── render.js      # sharp + SVG 渲染标注 PNG
│   └── exporter.js    # CSV（测量/汇总/视野统计/比较）与 ZIP 导出
├── public/            # 前端（原生 JS，无需构建；transfer.js 为迁移页）
├── test-geometry.js   # 几何自测（npm test）
├── test-fields.js     # 视野密度统计自测（npm test）
├── test-compare.js    # 报告比较自测（npm test）
├── test-transfer.js   # 细胞迁移自测：纯函数 + HTTP 全链路（npm test）
└── data/              # 运行后生成：app.db、images/、snapshots/
```

## HTTP 接口与调用示例（取样视野 / 细胞密度）

视野与细胞轮廓一样属于**草稿**，随 `GET /api/images/:id` 一起返回；几何点一律为
图片原始像素坐标 `{x, y}`，环为点数组（首尾不需要重复），孔洞为环数组。
视野保存是**整批替换**并携带草稿 `version` 做乐观并发控制。

`GET /api/images/:id` 在 `fields` 之外还返回实时计算的 `fieldStats`（数组，按保存顺序）：

```json
{
  "id": "7ca3…", "version": 4,
  "fields": [
    { "id": "f1", "name": "视野1",
      "outer": [{"x":0,"y":0},{"x":100,"y":0},{"x":100,"y":100},{"x":0,"y":100}],
      "holes": [] }
  ],
  "fieldStats": [{
    "id": "f1", "name": "视野1", "holes": 0,
    "cellCount": 1,
    "countedCellKeys": ["cellA"],
    "areaMm2": 0.01, "densityPerMm2": 100, "countedCellAreaMm2": 0.0016,
    "areaText": "0.01", "densityText": "100", "countedCellAreaText": "0.0016",
    "calibrated": true
  }]
}
```

未定标时数值字段为 `null`，三个展示文本统一为 **`"待定标"`**，`cellCount` 照常给出；
`countedCellKeys` 为该视野计入细胞的标识（细胞 `id`，历史无 id 时为 `#序号`）。

### 保存视野（整批替换）

`PUT /api/images/:id/fields`，请求体：

```json
{
  "version": 3,
  "fields": [
    { "id": "f1", "name": "视野1",
      "outer": [{"x":0,"y":0},{"x":100,"y":0},{"x":100,"y":100},{"x":0,"y":100}],
      "holes": [] },
    { "id": "f2", "name": "视野2",
      "outer": [{"x":0,"y":0},{"x":200,"y":0},{"x":200,"y":200},{"x":0,"y":200}],
      "holes": [ [{"x":20,"y":20},{"x":40,"y":20},{"x":40,"y":40},{"x":20,"y":40}] ] }
  ]
}
```

- 成功返回**更新后的整份草稿**（`version + 1`、含新 `fieldStats`）；
- 视野越界 / 自交 / 孔洞不严格位于外环内 / 孔洞彼此接触或重叠 / 净面积非正
  → **HTTP 400**，错误信息指出具体视野，**整批不写入、版本不变**；
- 携带的 `version` 过期 → **HTTP 409** `{error, currentVersion}`，按草稿冲突处理，整次不写入；
- 视野与轮廓共用同一草稿版本：先存轮廓会让旧 `version` 失效，重新 `GET` 后再存视野即可。

curl 示例：

```bash
# 1) 取版本号
curl -s http://localhost:8080/api/images/$IMG_ID | jq .version

# 2) 保存两个视野（一个带孔洞）
curl -s -X PUT http://localhost:8080/api/images/$IMG_ID/fields \
  -H 'Content-Type: application/json' \
  -d @fields.json

# 3) 发布（冻结视野与统计；同样要带读取时版本号）
curl -s -X POST http://localhost:8080/api/images/$IMG_ID/publish \
  -H 'Content-Type: application/json' \
  -d '{"version":4,"title":"切片A 报告"}'
```

Node.js 示例（无第三方依赖）：

```js
const base = 'http://localhost:8080';

async function saveFields(imageId, fields) {
  const img = await fetch(`${base}/api/images/${imageId}`).then((r) => r.json());
  const res = await fetch(`${base}/api/images/${imageId}/fields`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: img.version, fields })
  });
  if (res.status === 409) {
    const { currentVersion } = await res.json();
    throw new Error(`草稿冲突，请用最新版本 v${currentVersion} 重试`);
  }
  if (!res.ok) throw new Error((await res.json()).error); // 400：整批被拒
  const saved = await res.json();
  for (const s of saved.fieldStats) {
    console.log(`${s.name}: 净面积 ${s.areaText} mm², 细胞 ${s.cellCount}, ` +
                `密度 ${s.densityText} 个/mm², 计入净面积总和 ${s.countedCellAreaText} mm²`);
  }
}

saveFields(process.env.IMG_ID, [
  { name: '中心视野',
    outer: [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}],
    holes: [] }
]);
```

### 冻结结果（报告页与视野统计 CSV 完全一致）

`GET /api/reports/:id` 返回发布时冻结的 `fields` 与 `fieldStats`；
旧报告缺少视野时二者都是空列表。单独导出：

```bash
curl -s -OJ http://localhost:8080/api/reports/$REPORT_ID/field-csv
# -> <report_id>_fields.csv（UTF-8 BOM）
# 列：视野名称,孔洞数,净面积(mm²),细胞数,细胞密度(个/mm²),计入细胞净面积总和(mm²)
# 未定标/旧报告对应列为“待定标”或“（无取样视野）”
```

原 `GET /api/reports/:id/csv`（测量 CSV，μm²）、`/png`、批量导出与报告比较结果
**保持原义不变**；视野统计是独立 CSV，不混入测量 CSV。

## 报告比较 HTTP 接口

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/comparisons` | 比较记录列表（标题、两侧报告、配对数、版本、时间） |
| `POST /api/comparisons` | 新建：`{baselineReportId, retestReportId, title?, pairs:[{baselineCellKey, retestCellKey}]}`；报告不存在/两侧相同/配对重复/细胞不存在 → 400，整次不生效 |
| `GET /api/comparisons/:id` | 比较结果：两侧冻结定标、逐对细胞两侧数值/带符号差值/变化率（基线 0 为 `不可计算`）、两侧未配对细胞 |
| `PUT /api/comparisons/:id` | 修改标题与配对（两侧报告不可更换），须携带读取时 `version`；过期 → 409 并返回 `currentVersion`，整次修改不写入 |
| `GET /api/comparisons/:id/csv` | 导出与页面一致的比较 CSV（UTF-8 BOM） |

| `GET /api/comparisons/:id/csv` | 导出与页面一致的比较 CSV（UTF-8 BOM） |

## 细胞迁移 HTTP 接口（已发布报告 → 图片草稿）

两个接口都**只读来源报告、只写目标草稿**，且服务端使用**同一个 `planTransfer`**
（`server/transfer.js`）计算仿射变换与逐细胞校验，保证预览与提交一致。

- 坐标系：`sourcePoints` 为**来源报告原图**像素坐标（见报告 `width/height`），
  `targetPoints` 为**目标草稿原图**像素坐标（见草稿 `width/height`）；
- 两组点均为**恰好 3 个**、按顺序一一对应（来源点 i 对应目标点 i），
  必须互不重合（间距 ≥ 1 px）、不共线、不越出各自图片；
- 仿射变换（含平移/旋转/缩放/错切，允许镜像）由三点唯一确定；映射后的每个细胞
  都要通过与「保存轮廓」完全相同的几何规则（越界/自交/孔洞严格在内/孔洞互不接触）。

### 预览（不写入）

`POST /api/transfers/preview`

```json
{
  "sourceReportId": "9f1c…",
  "targetImageId": "7ca3…",
  "sourcePoints": [{"x":120,"y":80},{"x":900,"y":120},{"x":200,"y":860}],
  "targetPoints": [{"x":60,"y":40},{"x":460,"y":60},{"x":100,"y":430}]
}
```

成功 `200`：

```json
{
  "ok": true,
  "targetVersion": 4,
  "plan": {
    "affine": {"a":0.51,"b":0.004,"c":-0.002,"d":0.48,"e":-2.1,"f":3.4,"det":0.245},
    "source": {"reportId":"9f1c…","title":"切片A 报告","width":1600,"height":1200,"cellCount":12},
    "target": {"imageId":"7ca3…","width":800,"height":600,"version":4,"existingCellCount":3},
    "srcPoints": [{"x":120,"y":80},{"x":900,"y":120},{"x":200,"y":860}],
    "dstPoints": [{"x":60,"y":40},{"x":460,"y":60},{"x":100,"y":430}],
    "cells": [{
      "sourceIndex": 1, "sourceCellId": "…", "name": "表皮细胞 1", "holesCount": 1,
      "outer": [{"x":…,"y":…}], "holes": [[{"x":…,"y":…}]],
      "areaUm2": 1523.4, "perimeterUm": 188.2,
      "valid": true, "error": null
    }],
    "mappedCount": 12, "errorCount": 0, "valid": true, "errors": []
  }
}
```

- 来源报告不存在 / 目标草稿不存在 → **HTTP 404**；
- 来源报告无细胞、点重合/共线/越界 → **HTTP 400** 并指出具体一侧与点序号；
- 映射后存在不合法轮廓 → **HTTP 400**，响应体仍含 `plan`（逐细胞 `valid/error`，
  以及可直接绘制的 `outer/holes`），`valid:false`，用于页面红色标出失败细胞；
- 预览**不写任何数据、不改变版本**；`areaUm2/perimeterUm` 已按**目标标尺**计算，
  目标未定标时为 `null`。

### 提交（整批追加，乐观版本）

`POST /api/transfers/commit`，请求体在预览请求基础上**增加预览时返回的 `version`**：

```json
{
  "sourceReportId": "9f1c…",
  "targetImageId": "7ca3…",
  "sourcePoints": [{"x":120,"y":80},{"x":900,"y":120},{"x":200,"y":860}],
  "targetPoints": [{"x":60,"y":40},{"x":460,"y":60},{"x":100,"y":430}],
  "version": 4
}
```

- 成功 `201`：`{ ok, addedCount, addedCells:[…新 id/保留名称/按目标标尺的测量…], image }`，
  `image` 为追加后的整份目标草稿（`version + 1`、含实时重算的 `fieldStats`）；
  映射细胞追加在原有细胞之后，自动生成与现有/本批细胞**均不冲突的 UUID**；
- 缺少/非整数 `version` → **HTTP 400**；
- `version` 与当前目标草稿不一致 → **HTTP 409** `{error, currentVersion}`，**整批不写入**，
  需重新 `GET` 目标与重新预览；
- 服务端会用请求中的点**重算同一计划并再次逐细胞校验**：任何失败同样 **400 整批不写入**；
- 来源报告（含其冻结细胞与快照）、目标原有细胞与标尺、其它已发布报告均不改变。

curl 示例：

```bash
# 1) 预览（保存返回的 targetVersion；映射点与轮廓见 plan.cells）
curl -s -X POST http://localhost:8080/api/transfers/preview \
  -H 'Content-Type: application/json' -d @preview.json | tee preview.out.json
# -> {"ok":true,"targetVersion":4,"plan":{…}}
TARGET_VER=$(jq .targetVersion preview.out.json)

# 2) 用与预览完全相同的点，再加上预览版本号提交
jq --argjson v "$TARGET_VER" '. + {version: $v}' preview.json > commit.json
curl -s -X POST http://localhost:8080/api/transfers/commit \
  -H 'Content-Type: application/json' -d @commit.json
# 版本过期 -> HTTP 409 {"error":"…请刷新…","currentVersion":5}
```

Node.js 示例（无第三方依赖；过期自动停止并提示刷新）：

```js
const base = 'http://localhost:8080';

async function transferCells({ sourceReportId, targetImageId, sourcePoints, targetPoints }) {
  // 预览：点重合/共线/越界/映射后有非法轮廓会直接抛出，禁止提交
  const preview = await fetch(`${base}/api/transfers/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceReportId, targetImageId, sourcePoints, targetPoints })
  }).then(async (r) => {
    const b = await r.json();
    if (!r.ok) throw new Error(b.error || `预览失败 HTTP ${r.status}`);
    return b;
  });
  for (const c of preview.plan.cells) {
    console.log(`${c.valid ? '✔' : '✘'} ${c.name}（孔洞 ${c.holesCount}）` +
      (c.valid ? ` 净面积 ${c.areaUm2 ?? '未定标'} μm²` : `：${c.error}`));
  }

  // 提交必须携带预览时读取的目标草稿版本
  const res = await fetch(`${base}/api/transfers/commit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceReportId, targetImageId, sourcePoints, targetPoints,
      version: preview.targetVersion
    })
  });
  const body = await res.json();
  if (res.status === 409) {
    throw new Error(`目标草稿已过期（当前 v${body.currentVersion}），请刷新后重新预览再提交`);
  }
  if (!res.ok) throw new Error(body.error);
  console.log(`已追加 ${body.addedCount} 个细胞，目标草稿现为 v${body.image.version}`);
}
```

## 全部 HTTP 接口一览（既有 + 本轮）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/images` / `POST /api/images` | 草稿列表 / 上传图片（multipart 字段 `image`） |
| `GET /api/images/:id` | 草稿详情（含 `cells`、`fields`、实时 `fieldStats`） |
| `GET /api/images/:id/file` | 原始图片 |
| `PUT /api/images/:id/calibration` | 定标/重定标（带 `version`，过期 409）；视野统计随新比例重算 |
| `PUT /api/images/:id/contours` | 整批保存细胞轮廓（带 `version`；非法 400 整批不生效；过期 409） |
| **`PUT /api/images/:id/fields`** | **整批保存取样视野（带 `version`；非法 400 整批不生效；过期 409）** |
| `POST /api/images/:id/publish` | 发布冻结（含视野与统计；带 `version`，过期 409） |
| `GET /api/reports` / `GET /api/reports/:id` | 报告列表 / 冻结详情（旧报告 `fields` 为空列表） |
| `GET /api/reports/:id/file` / `/png` | 发布时图片快照 / 标注 PNG |
| `GET /api/reports/:id/csv` | 测量 CSV（μm²，原义不变） |
| **`GET /api/reports/:id/field-csv`** | **视野统计 CSV（mm²，与报告页同一冻结结果）** |
| `POST /api/reports/export` | 批量导出 `{ids, format:'csv'\|'png'\|'zip'}` |
| **`POST /api/transfers/preview`** | **细胞迁移预览：三点仿射映射 + 逐细胞校验（不写入；点/几何非法 400，报告/目标缺失 404）** |
| **`POST /api/transfers/commit`** | **整批追加迁移细胞（带预览时 `version`；过期 409；失败整批不写入）** |
| `GET/POST /api/comparisons`、`GET/PUT /api/comparisons/:id`、`GET /api/comparisons/:id/csv` | 报告比较（见上表） |
