// ============================================================
// 生成无口令 SSH 密钥（用 node:child_process 精确传参）
//
// 为什么不直接在 PowerShell 里调 ssh-keygen：
//   `-N '""'` 会被 PowerShell 解析成两个字面引号，ssh-keygen 认为"有口令"，
//   于是在非交互环境里挂死等输入。本脚本用 spawnSync + 参数数组，
//   确保 -N 收到的是真正的空字符串。
//
// 用法：node scripts/gen-ssh-key.mjs <私钥路径> [注释]
// ============================================================
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const out = process.argv[2]
const comment = process.argv[3] || 'dshc-deploy'
if (!out) {
  console.error('用法: node scripts/gen-ssh-key.mjs <私钥路径> [注释]')
  process.exit(2)
}
mkdirSync(dirname(out), { recursive: true })
for (const f of [out, out + '.pub']) if (existsSync(f)) rmSync(f, { force: true })

const KEYGEN = process.env.SSH_KEYGEN || 'ssh-keygen.exe'

// 1) 生成 Ed25519 密钥，-N 传空字符串（无口令）
const gen = spawnSync(KEYGEN, ['-t', 'ed25519', '-f', out, '-N', '', '-C', comment, '-q'], { encoding: 'utf8' })
if (gen.status !== 0) {
  console.error('ssh-keygen 生成失败：' + (gen.stderr || gen.error || '未知错误'))
  process.exit(1)
}

// 2) 校验：用私钥导出公钥。若私钥有口令，这里会失败或卡住 → 用 -P 明确传空口令
const check = spawnSync(KEYGEN, ['-y', '-f', out, '-P', ''], { encoding: 'utf8', timeout: 15000 })
if (check.status !== 0 || !/^ssh-ed25519 /.test(String(check.stdout || ''))) {
  console.error('私钥校验失败（可能仍带口令）：' + (check.stderr || check.error || ''))
  process.exit(1)
}

// 3) 收紧权限（Windows：禁用继承并只授予本用户与 SYSTEM）
if (process.platform === 'win32') {
  const me = (process.env.USERNAME || '') + ':(F)'
  spawnSync('icacls', [out, '/inheritance:r'], { encoding: 'utf8' })
  spawnSync('icacls', [out, '/grant', me], { encoding: 'utf8' })
  spawnSync('icacls', [out, '/grant', 'SYSTEM:(F)'], { encoding: 'utf8' })
} else {
  try { chmodSync(out, 0o600) } catch (e) {}
}

const pub = readFileSync(out + '.pub', 'utf8').trim()
// 4) 二次校验：解析指纹（能被 ssh-keygen 解析说明格式合法）
const fp = spawnSync(KEYGEN, ['-l', '-f', out + '.pub'], { encoding: 'utf8' })
console.log('私钥: ' + out)
console.log('公钥: ' + out + '.pub')
console.log('指纹: ' + String(fp.stdout || '').trim())
console.log('公钥内容: ' + pub)
