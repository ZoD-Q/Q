import { WorkbenchError } from '../api-workbench/core';
import { decodeTool, record, type PluginTool } from '../plugin-host/core';

export const FRED_TOOLS = ['fred-search-series', 'fred-get-series-metadata', 'fred-get-series-observations'] as const;
export type FredToolName = typeof FRED_TOOLS[number];
export type FredField = { name: string; type: 'string' | 'number' | 'integer' | 'boolean'; required: boolean; choices?: string[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; format?: string };
export type FredCatalog = { connection_revision: number; items: PluginTool[]; retention: 'ephemeral' };
export type FredReading = { retrievedAt: string; rows: { label: string; value: string }[]; limited: boolean };
const fail = (code = 'INVALID_RESPONSE'): never => { throw new WorkbenchError(code); };
const bounded = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
export const fredToolName = (value: string): value is FredToolName => (FRED_TOOLS as readonly string[]).includes(value);
export function decodeFredCatalog(value: unknown): FredCatalog {
  if (!record(value) || value.retention !== 'ephemeral' || !Number.isSafeInteger(value.connection_revision) || Number(value.connection_revision) < 1 || !Array.isArray(value.items) || !value.items.length || value.items.length > 3) return fail();
  const items = value.items.map(decodeTool);
  if (items.some(item => !fredToolName(item.name)) || new Set(items.map(item => item.name)).size !== items.length) return fail();
  return { connection_revision: Number(value.connection_revision), items, retention: 'ephemeral' };
}
export function fredFields(tool: PluginTool): FredField[] {
  const schema = tool.inputSchema;
  if (schema.type !== 'object' || !record(schema.properties) || Object.keys(schema.properties).length > 24
    || ['oneOf', 'anyOf', 'allOf', '$ref', 'if', 'dependencies', 'dependentRequired'].some(key => key in schema)) return fail('FRED_FORM_UNSUPPORTED');
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties as object, key))) return fail('FRED_FORM_UNSUPPORTED');
  return Object.entries(schema.properties).map(([name, value]): FredField => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) || /password|secret|token|api_?key|authorization|cookie/i.test(name) || !record(value) || !['string', 'number', 'integer', 'boolean'].includes(String(value.type))
      || Object.keys(value).some(key => !['type', 'description', 'title', 'default', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format'].includes(key))) return fail('FRED_FORM_UNSUPPORTED');
    if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length || value.enum.length > 30 || value.enum.some(item => !bounded(item, 100)))) return fail('FRED_FORM_UNSUPPORTED');
    if (value.pattern !== undefined || value.format !== undefined && !['date', 'date-time'].includes(String(value.format))) return fail('FRED_FORM_UNSUPPORTED');
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) return fail('FRED_FORM_UNSUPPORTED');
    return { name, type: value.type as FredField['type'], required: required.includes(name),
      ...(Array.isArray(value.enum) ? { choices: value.enum as string[] } : {}),
      ...(typeof value.minimum === 'number' ? { minimum: value.minimum } : {}), ...(typeof value.maximum === 'number' ? { maximum: value.maximum } : {}),
      ...(typeof value.minLength === 'number' ? { minLength: value.minLength } : {}), ...(typeof value.maxLength === 'number' ? { maxLength: Math.min(value.maxLength, 500) } : {}),
      ...(typeof value.format === 'string' ? { format: value.format } : {}) };
  });
}
export function fredArguments(fields: FredField[], input: Record<string, string>): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const field of fields) {
    const value = (input[field.name] ?? '').trim();
    if (!value) { if (field.required) return fail('FRED_INPUT_INVALID'); continue; }
    if (!bounded(value, field.maxLength ?? 500) || value.length < (field.minLength ?? 0) || field.choices && !field.choices.includes(value)) return fail('FRED_INPUT_INVALID');
    if (field.type === 'boolean') { if (!['true', 'false'].includes(value)) return fail('FRED_INPUT_INVALID'); result[field.name] = value === 'true'; }
    else if (field.type === 'number' || field.type === 'integer') {
      if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return fail('FRED_INPUT_INVALID');
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || field.type === 'integer' && !Number.isSafeInteger(parsed) || field.minimum !== undefined && parsed < field.minimum || field.maximum !== undefined && parsed > field.maximum) return fail('FRED_INPUT_INVALID');
      result[field.name] = parsed;
    } else {
      if (field.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return fail('FRED_INPUT_INVALID');
      if (field.format === 'date-time' && !Number.isFinite(Date.parse(value))) return fail('FRED_INPUT_INVALID');
      result[field.name] = value;
    }
  }
  return result;
}
const labels: Record<string, [string, string]> = {
  search_text: ['搜索关键词', 'Search terms'], query: ['搜索关键词', 'Search terms'], series_id: ['指标编号', 'Series ID'], seriesId: ['指标编号', 'Series ID'],
  observation_start: ['开始日期', 'Start date'], observation_end: ['结束日期', 'End date'], start_date: ['开始日期', 'Start date'], end_date: ['结束日期', 'End date'],
  limit: ['结果数量', 'Result limit'], offset: ['起始位置', 'Starting offset'], order_by: ['排序依据', 'Order by'], sort_order: ['排序方向', 'Sort order'],
  units: ['单位与转换', 'Units and transformation'], frequency: ['频率', 'Frequency'], aggregation_method: ['汇总方式', 'Aggregation'],
  id: ['指标编号', 'Series ID'], title: ['指标名称', 'Series title'], notes: ['说明', 'Notes'], date: ['观察日期', 'Observation date'], value: ['数值', 'Value'],
  observation_date: ['观察日期', 'Observation date'], realtime_start: ['数据版本起始日', 'Vintage start'], realtime_end: ['数据版本结束日', 'Vintage end'],
  last_updated: ['来源更新时间', 'Source updated'], seasonal_adjustment: ['季节调整', 'Seasonal adjustment'], count: ['记录数', 'Record count'],
  popularity: ['关注度', 'Popularity'], frequency_short: ['频率', 'Frequency'], units_short: ['单位', 'Units'],
  series: ['经济指标', 'Series'], seriess: ['经济指标', 'Series'], observations: ['历史数据', 'Observations'], metadata: ['指标口径', 'Metadata'],
  data: ['数据', 'Data'], result: ['结果', 'Result'], results: ['结果', 'Results'], source: ['来源', 'Source'],
  start: ['开始日期', 'Start date'], end: ['结束日期', 'End date'], description: ['说明', 'Description'],
};
export function fredLabel(name: string, locale: 'zh' | 'en'): string {
  const value = labels[name];
  return value ? value[locale === 'zh' ? 0 : 1] : name.replace(/[_-]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
}
export function fredToolLabel(name: string, locale: 'zh' | 'en'): string {
  const index = FRED_TOOLS.indexOf(name as FredToolName);
  return (locale === 'zh' ? ['查找经济指标', '了解指标口径', '读取历史数据'] : ['Find economic series', 'Understand a series', 'Read historical data'])[index] ?? '';
}
export function decodeFredReading(value: unknown, expected: { id: string; revision: number; tool: string }, locale: 'zh' | 'en'): FredReading {
  if (!record(value) || value.retention !== 'ephemeral' || value.connection_id !== expected.id || value.connection_revision !== expected.revision || value.tool_name !== expected.tool
    || !bounded(value.retrieved_at, 80) || !Number.isFinite(Date.parse(value.retrieved_at)) || !record(value.result) || value.result.isError === true) return fail('FRED_RESULT_INVALID');
  const result = value.result, rows: FredReading['rows'] = []; let limited = false, nodes = 0;
  const append = (label: string, item: unknown, depth: number) => {
    if (++nodes > 3000 || depth > 8) return fail('FRED_RESULT_INVALID');
    if (rows.length >= 160) { limited = true; return; }
    if (item === null) { rows.push({ label, value: locale === 'zh' ? '缺失' : 'Missing' }); return; }
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      if (typeof item === 'number' && !Number.isFinite(item) || typeof item === 'string' && !bounded(item, 16000)) return fail('FRED_RESULT_INVALID');
      if (typeof item === 'string' && /^[\[{]/.test(item.trim())) { let nested: unknown; try { nested = JSON.parse(item); } catch { return fail('FRED_RESULT_INVALID'); } append(label, nested, depth + 1); return; }
      rows.push({ label, value: String(item) === '.' ? locale === 'zh' ? '缺失' : 'Missing' : String(item) }); return;
    }
    if (Array.isArray(item)) {
      if (item.length > 2000) return fail('FRED_RESULT_INVALID');
      item.forEach((entry, i) => append(`${label} ${i + 1}`, entry, depth + 1)); return;
    }
    if (!record(item) || Object.keys(item).length > 80) return fail('FRED_RESULT_INVALID');
    for (const [key, child] of Object.entries(item)) {
      if (!bounded(key, 100)) return fail('FRED_RESULT_INVALID');
      append(`${label ? `${label} · ` : ''}${fredLabel(key, locale)}`, child, depth + 1);
    }
  };
  if (result.structuredContent !== undefined) append('', result.structuredContent, 0);
  else {
    if (!Array.isArray(result.content) || result.content.length > 20) return fail('FRED_RESULT_INVALID');
    for (const block of result.content) {
      if (!record(block) || block.type !== 'text' || !bounded(block.text, 120000)) return fail('FRED_RESULT_INVALID');
      const content = block.text.trim();
      if (/^[\[{]/.test(content)) { let parsed: unknown; try { parsed = JSON.parse(content); } catch { return fail('FRED_RESULT_INVALID'); } append('', parsed, 0); }
      else append(locale === 'zh' ? '来源说明' : 'Source response', content, 0);
    }
  }
  if (!rows.length) return fail('FRED_RESULT_INVALID');
  return { retrievedAt: value.retrieved_at, rows, limited };
}
