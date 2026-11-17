'use strict';
/**
 * dwc.js — Darwin Core 导出（occurrence.txt + taxon.txt + meta.xml）
 *
 * 为什么值得做：标本馆、保护区、合作单位、GBIF / iNaturalist 之间交换数据，
 * 认的就是这一套字段名。我们手里已经有「学名 + 拍摄时间 + 经纬度 + 照片」，
 * 差的只是把列名换成 dwc 的规范名 —— 不用改任何采集流程。
 *
 * 输出是一个可直接导入的 Darwin Core Archive（zip）：
 *   occurrence.txt  核心表，一行一张照片（basisOfRecord=MachineObservation）
 *   taxon.txt       物种表，一行一个物种（taxonID 与核心表对得上）
 *   meta.xml        告诉 GBIF / IPT 哪份是核心、哪列是什么术语
 *   README.txt      给不熟这套格式的人看的说明
 *
 * 约定：
 *   - 制表符分隔、UTF-8 无 BOM（DwC-A 的标准写法，Excel 打开会串列，用 IPT 或 pandas 看）；
 *   - occurrenceID / taxonID 都由「相对路径 / 学名」哈希出稳定值，重导一次不会变，
 *     重复导入时 GBIF 靠它去重；
 *   - 没有坐标的照片照样导出（decimalLatitude 留空），但会少一个「有坐标」标记，
 *     用户自己决定要不要筛掉。
 */

const crypto = require('node:crypto');

const DWC = 'http://rs.tdwg.org/dwc/terms/';

/** 核心表列（顺序即 meta.xml 里的 index，改顺序必须同步改 meta） */
const OCC_COLUMNS = [
  ['occurrenceID', 'occurrenceID'],
  ['basisOfRecord', 'basisOfRecord'],
  ['occurrenceStatus', 'occurrenceStatus'],
  ['scientificName', 'scientificName'],
  ['taxonRank', 'taxonRank'],
  ['kingdom', 'kingdom'],
  ['phylum', 'phylum'],
  ['class', 'class'],
  ['order', 'order'],
  ['family', 'family'],
  ['genus', 'genus'],
  ['vernacularName', 'vernacularName'],
  ['taxonID', 'taxonID'],
  ['eventDate', 'eventDate'],
  ['year', 'year'],
  ['month', 'month'],
  ['day', 'day'],
  ['decimalLatitude', 'decimalLatitude'],
  ['decimalLongitude', 'decimalLongitude'],
  ['geodeticDatum', 'geodeticDatum'],
  ['coordinateUncertaintyInMeters', 'coordinateUncertaintyInMeters'],
  ['country', 'country'],
  ['countryCode', 'countryCode'],
  ['locality', 'locality'],
  ['recordedBy', 'recordedBy'],
  ['identificationRemarks', 'identificationRemarks'],
  ['associatedMedia', 'associatedMedia'],
  ['catalogNumber', 'catalogNumber'],
  ['references', 'references'],
  ['occurrenceRemarks', 'occurrenceRemarks'],
];

const TAXON_COLUMNS = [
  ['taxonID', 'taxonID'],
  ['scientificName', 'scientificName'],
  ['taxonRank', 'taxonRank'],
  ['kingdom', 'kingdom'],
  ['phylum', 'phylum'],
  ['class', 'class'],
  ['order', 'order'],
  ['family', 'family'],
  ['genus', 'genus'],
  ['vernacularName', 'vernacularName'],
  ['taxonRemarks', 'taxonRemarks'],
];

const clean = (v) => String(v == null ? '' : v).replace(/[\t\r\n]+/g, ' ').trim();
const hash = (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 16);
const occId = (rel) => `tagden:occ:${hash(rel)}`;
const taxId = (latin, cn) => `tagden:tax:${hash(`${latin || ''}|${cn || ''}`)}`;

/** 摄影记录：照片是「机器观测」，不是采集的标本 */
const BASIS = 'MachineObservation';

/** 日期拆成 eventDate / year / month / day（拍摄时间可能是 "2026-05-01 08:30:00"） */
function splitDate(taken) {
  const s = String(taken || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return { eventDate: '', year: '', month: '', day: '' };
  return { eventDate: `${m[1]}-${m[2]}-${m[3]}`, year: m[1], month: m[2], day: m[3] };
}

function tsv(columns, rows) {
  const head = columns.map((c) => c[0]).join('\t');
  const body = rows
    .map((r) =>
      columns
        .map(([key]) => clean(r[key]))
        .join('\t'),
    )
    .join('\n');
  return `${head}\n${body}${body ? '\n' : ''}`;
}

/**
 * @param {Array} rows     scanLabeled() 出来的明细
 * @param {Array} species  [{cn, latin, order:{latin,cn}, family:{...}, genus:{...}, n, gps}]
 */
function build(rows, species) {
  // 学名/中文名 → 物种对象，用于给每行补分类阶元
  const byKey = new Map();
  for (const s of species) {
    byKey.set(`${String(s.latin || '').toLowerCase()}|${s.cn || ''}`, s);
  }
  const rank = (s, r) => (s && s[r] && (s[r].latin || s[r].cn)) || '';

  const occ = rows.map((r) => {
    const s = byKey.get(`${String(r.latin || '').toLowerCase()}|${r.cn || ''}`);
    const d = splitDate(r.taken);
    return {
      occurrenceID: occId(r.rel || r.file),
      basisOfRecord: BASIS,
      occurrenceStatus: 'present',
      scientificName: r.latin || r.cn,
      taxonRank: 'species',
      kingdom: rank(s, 'kingdom'),
      phylum: rank(s, 'phylum'),
      class: rank(s, 'class'),
      order: rank(s, 'order'),
      family: rank(s, 'family'),
      genus: rank(s, 'genus'),
      vernacularName: r.cn || '',
      taxonID: taxId(r.latin, r.cn),
      eventDate: d.eventDate,
      year: d.year,
      month: d.month,
      day: d.day,
      decimalLatitude: r.lat == null ? '' : Number(r.lat).toFixed(6),
      decimalLongitude: r.lon == null ? '' : Number(r.lon).toFixed(6),
      geodeticDatum: r.lat == null || r.lon == null ? '' : 'WGS84',
      coordinateUncertaintyInMeters: '',
      country: '中国',
      countryCode: 'CN',
      locality: r.folder || '',
      recordedBy: '',
      identificationRemarks: r.source ? `识别来源：${r.source}` : '',
      associatedMedia: r.file || '',
      catalogNumber: r.rel || r.file || '',
      references: r.rel || '',
      occurrenceRemarks: r.note || '',
    };
  });

  const tax = species.map((s) => ({
    taxonID: taxId(s.latin, s.cn),
    scientificName: s.latin || s.cn,
    taxonRank: 'species',
    kingdom: rank(s, 'kingdom'),
    phylum: rank(s, 'phylum'),
    class: rank(s, 'class'),
    order: rank(s, 'order'),
    family: rank(s, 'family'),
    genus: rank(s, 'genus'),
    vernacularName: s.cn || '',
    taxonRemarks: rank(s, 'order') ? '' : '分类阶元未解析（本机名录未覆盖）',
  }));

  const meta = metaXml();
  const readme = [
    'Darwin Core Archive（物种标注工坊 tagden 导出）',
    '',
    `照片记录：${occ.length} 条；物种：${tax.length} 个。`,
    '',
    '文件：',
    '  occurrence.txt  核心表，一行一张照片',
    '  taxon.txt       物种表（taxonID 与核心表一致，可用于核对分类）',
    '  meta.xml        告诉 IPT / GBIF 每列是什么术语',
    '',
    '怎么用：',
    '  1) GBIF / IPT：新建 Darwin Core Archive 数据集，上传这个 zip 即可；',
    '  2) 合作单位：occurrence.txt 是制表符分隔的 UTF-8 文本，R 里 read.delim() 直接读；',
    '  3) Excel 打开会串列（Tab 被当分隔符），建议用「数据 → 自文本」导入并指定 Tab。',
    '',
    '字段口径：',
    '  basisOfRecord = MachineObservation（相机/手机拍摄的观测记录，不是采集标本）',
    '  geodeticDatum = WGS84（EXIF 的 GPS 就是 WGS84）',
    '  occurrenceID / taxonID 由路径与学名哈希而来，重复导入可去重',
    '  没有坐标的照片照样导出，decimalLatitude/Longitude 留空',
    '',
  ].join('\n');

  return {
    occurrence: tsv(OCC_COLUMNS, occ),
    taxon: tsv(TAXON_COLUMNS, tax),
    meta,
    readme,
    counts: { occurrences: occ.length, taxa: tax.length, withCoord: occ.filter((o) => o.decimalLatitude).length },
  };
}

function metaXml() {
  const fields = OCC_COLUMNS.map(([, term], i) => `    <field index="${i}" term="${DWC}${term}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<archive xmlns="http://rs.tdwg.org/dwc/text/">
  <core encoding="UTF-8" fieldsTerminatedBy="\\t" linesTerminatedBy="\\n" fieldsEnclosedBy="" ignoreHeaderLines="1" rowType="${DWC}Occurrence">
    <files>
      <location>occurrence.txt</location>
    </files>
    <id index="0"/>
${fields}
  </core>
</archive>
`;
}

module.exports = { build, metaXml, OCC_COLUMNS, TAXON_COLUMNS, occId, taxId, splitDate };
