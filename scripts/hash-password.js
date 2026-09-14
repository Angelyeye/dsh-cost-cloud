#!/usr/bin/env node
// ============================================================
// 生成管理员口令哈希（scrypt）
//
//   node scripts/hash-password.js "你的口令"
//
// 把输出写入 .env 的 ADMIN_PASSWORD_HASH=... 后重启服务生效。
// ============================================================
import { hashPassword } from '../src/auth.js'

const pw = process.argv[2]
if (!pw) {
  console.error('用法：node scripts/hash-password.js "你的口令"')
  process.exit(2)
}
if (String(pw).length < 8) {
  console.error('口令至少 8 位（当前 ' + String(pw).length + ' 位）')
  process.exit(2)
}
console.log(hashPassword(String(pw)))
