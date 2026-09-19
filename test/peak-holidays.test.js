// ============================================================
// dsh-cost-cloud 法定节假日（峰谷口径）测试
//   node --test test/peak-holidays.test.js
//
// 官方口径：「北京时间周一至周五（**不含中国法定节假日**）9:00-12:00、14:00-18:00
// 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。」
// 云端是**权威算价方**，因此这里必须钉住三件事：
//   ① 配置项 DSH_PEAK_HOLIDAYS 真的接进了运行配置，并被 main 的启动流程注入定价层；
//   ② 入库重算（ingest）对节假日按闲时计，同一批 token 在节日/平日恰好差 1 倍；
//   ③ /api/v1/protocol 把节假日口径回显给采集端（两侧自查是否同源）。
// ============================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../src/config.js'
import { setPeakHolidays, getPeakHolidays, isPeak, isCnHoliday, holidayKeyAt, CN_HOLIDAYS } from '../src/pricing.js'
import { makeApp, addDevice, rec, ingestDirect } from './helpers.js'
import { call } from './http-client.js'

const at = (mo, d, h) => Date.UTC(2026, mo - 1, d, h - 8, 0, 0) // 北京时间 h:00

test('配置：DSH_PEAK_HOLIDAYS 进入运行配置（空 = 内置，none = 停用，其余 = 自定义原样）', () => {
  const base = { DATA_DIR: process.cwd(), SESSION_SECRET: 'x'.repeat(48), ADMIN_PASSWORD: 'p' }
  assert.equal(resolveConfig(base, {}).config.peakHolidays, '', '未设置 → 空串（用内置表）')
  assert.equal(resolveConfig(Object.assign({}, base, { DSH_PEAK_HOLIDAYS: '  ' }), {}).config.peakHolidays, '', '空白 → 空串')
  assert.equal(resolveConfig(Object.assign({}, base, { DSH_PEAK_HOLIDAYS: 'none' }), {}).config.peakHolidays, 'none')
  assert.equal(
    resolveConfig(Object.assign({}, base, { DSH_PEAK_HOLIDAYS: ' 2027-01-01, 2027/2/5 ' }), {}).config.peakHolidays,
    '2027-01-01, 2027/2/5',
    '自定义列表去除首尾空白后原样保留（由 setPeakHolidays 解释）'
  )
})

test('定价层：节假日全天闲时（含调休补班与跨年覆盖语义）', () => {
  try {
    assert.ok(CN_HOLIDAYS.length >= 30, '内置 2026 全年放假日')
    assert.equal(holidayKeyAt(at(10, 1, 0)), '2026-10-01', '北京日历日切分')
    assert.equal(isCnHoliday(at(10, 1, 10)), true)

    setPeakHolidays('') // 内置表
    assert.equal(isPeak(at(9, 24, 10)), true, '09-24 周四平日 → 高峰')
    assert.equal(isPeak(at(9, 25, 10)), false, '09-25 周五中秋 → 闲时')
    assert.equal(isPeak(at(10, 1, 10)), false, '10-01 国庆 → 闲时')
    assert.equal(isPeak(at(10, 8, 10)), true, '10-08 节后 → 高峰')
    assert.equal(isPeak(at(2, 16, 10)), false, '02-16 春节 → 闲时')
    assert.equal(isPeak(at(5, 9, 10)), false, '05-09 调休补班周六 → 仍闲时')
    assert.equal(isPeak(at(10, 10, 10)), false, '10-10 调休补班周六 → 仍闲时')

    setPeakHolidays('none')
    assert.equal(getPeakHolidays().disabled, true, '停用哨兵')
    assert.equal(isPeak(at(10, 1, 10)), true, '停用后国庆按高峰计')

    setPeakHolidays('2027-01-01 2027/2/5 无效条目')
    const hol = getPeakHolidays('2027-01-01 2027/2/5 无效条目')
    assert.equal(hol.mode, 'custom')
    assert.deepEqual(hol.dates, ['2027-01-01', '2027-02-05'], '归一化 + 排序 + 补零')
    assert.deepEqual(hol.invalid, ['无效条目'], '非法条目如实报告')
    assert.equal(isPeak(at(10, 1, 10)), true, '自定义表整体替换内置（国庆不再豁免）')
    assert.equal(isPeak(Date.UTC(2027, 1, 5, 2, 0, 0)), false, '自定义表覆盖 2027-02-05')
  } finally {
    setPeakHolidays('') // 恢复默认，避免影响其它用例
  }
})

test('入库重算：节假日按闲时计价（同一批 token 恰好差 1 倍）', () => {
  const { app, cleanup } = makeApp()
  try {
    const token = addDevice(app, 'dev-hol', 'dev-hol')
    const tokens = { input: 1000000, output: 1000000, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
    setPeakHolidays('')
    // 节假日（国庆 10-05 周一 10:00）与平日（10-08 周四 10:00）
    ingestDirect(app, { token, deviceId: 'dev-hol', records: [rec({ ts: at(10, 5, 10), tokens, cost: 0 })] })
    ingestDirect(app, { token, deviceId: 'dev-hol', records: [rec({ ts: at(10, 8, 10), tokens, cost: 0 })] })
    const rows = app.db.prepare('SELECT ts, cost, period, cost_basis FROM records ORDER BY ts').all()
    assert.equal(rows.length, 2)
    const holiday = rows.find((r) => r.ts === at(10, 5, 10))
    const workday = rows.find((r) => r.ts === at(10, 8, 10))
    assert.equal(holiday.period, 'off-peak', '节假日入库档位 = 闲时')
    assert.equal(workday.period, 'peak', '平日入库档位 = 高峰')
    // 10-05 是周一、10-08 是周四，两者同属 v41 时代、同为 Flash 模型
    assert.ok(Math.abs(workday.cost - holiday.cost * 2) < 1e-9, `闲时恰为高峰半价（${holiday.cost} vs ${workday.cost}）`)
  } finally {
    setPeakHolidays('')
    cleanup()
  }
})

test('protocol：pricing.peakHolidays 回显来源与条数（采集端自查同源）', async () => {
  const { app, cleanup } = makeApp()
  try {
    setPeakHolidays('')
    const res = await call(app, 'GET', '/api/v1/protocol')
    const body = res.body
    assert.equal(body.ok, true)
    assert.ok(body.pricing && body.pricing.peakHolidays, 'protocol 应回显峰谷节假日口径')
    assert.equal(body.pricing.peakHolidays.mode, 'builtin')
    assert.equal(body.pricing.peakHolidays.count, CN_HOLIDAYS.length)
    assert.match(String(body.pricing.peakWindows || ''), /法定节假日全天闲时/)
  } finally {
    setPeakHolidays('')
    cleanup()
  }
})
