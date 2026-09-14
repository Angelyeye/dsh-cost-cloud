#!/usr/bin/env bash
# ============================================================
# 零依赖上报示例（curl）
#
#   ./docs/examples/curl.sh <base-url> <token> [deviceId] [deviceName] [source]
#
# 例：
#   ./docs/examples/curl.sh http://127.0.0.1:8787 dshc_xxx 我的机器 办公台式机 dsh
# ============================================================
set -euo pipefail

BASE="${1:-http://127.0.0.1:8787}"
TOKEN="${2:-}"
DEVICE_ID="${3:-demo-machine-1}"
DEVICE_NAME="${4:-演示机器}"
SOURCE="${5:-demo}"

if [ -z "$TOKEN" ]; then
  echo "用法: $0 <base-url> <token> [deviceId] [deviceName] [source]" >&2
  exit 2
fi

echo "== 1. 能力协商 /api/v1/health =="
curl -sS "$BASE/api/v1/health" | head -c 600; echo

echo
echo "== 2. 心跳（验证令牌） =="
NOW=$(node -e 'process.stdout.write(String(Date.now()))')
curl -sS -X POST "$BASE/api/v1/ingest/heartbeat" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"syncVer\":1,\"source\":\"$SOURCE\",\"deviceId\":\"$DEVICE_ID\",\"sentAt\":$NOW}"; echo

echo
echo "== 3. 上报两条明细（同一 batchUid，可重复执行验证幂等） =="
BATCH="curl-demo-$NOW"
curl -sS -X POST "$BASE/api/v1/ingest/records" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{
    \"syncVer\": 1,
    \"source\": \"$SOURCE\",
    \"deviceId\": \"$DEVICE_ID\",
    \"deviceName\": \"$DEVICE_NAME\",
    \"agent\": { \"name\": \"curl-demo\", \"version\": \"1\" },
    \"resetEpoch\": 0,
    \"maxClientSeq\": 2,
    \"sentAt\": $NOW,
    \"batchUid\": \"$BATCH\",
    \"records\": [
      { \"seq\": 1, \"ts\": $NOW, \"provider\": \"deepseek-official\", \"model\": \"deepseek-v4.1-flash\",
        \"sessionId\": \"curl-s1\", \"purpose\": \"demo\",
        \"tokens\": { \"input\": 1000, \"output\": 500, \"cacheRead\": 2000, \"cacheWrite\": 0, \"reasoning\": 0 },
        \"cost\": 0.002 },
      { \"seq\": 2, \"ts\": $((NOW + 1000)), \"provider\": \"deepseek-official\", \"model\": \"deepseek-v4.1-flash\",
        \"sessionId\": \"curl-s1\", \"purpose\": \"demo\",
        \"tokens\": { \"input\": 1500, \"output\": 700, \"cacheRead\": 0, \"cacheWrite\": 0, \"reasoning\": 0 },
        \"cost\": 0.0036 }
    ]
  }"; echo

echo
echo "== 4. 再发一次同一 batchUid（应返回 replayed:true，计数不再增长） =="
curl -sS -X POST "$BASE/api/v1/ingest/records" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"syncVer\":1,\"source\":\"$SOURCE\",\"deviceId\":\"$DEVICE_ID\",\"batchUid\":\"$BATCH\",\"records\":[
      {\"seq\":1,\"ts\":$NOW,\"provider\":\"deepseek-official\",\"model\":\"deepseek-v4.1-flash\",\"sessionId\":\"curl-s1\",\"purpose\":\"demo\",
       \"tokens\":{\"input\":1000,\"output\":500,\"cacheRead\":2000,\"cacheWrite\":0,\"reasoning\":0},\"cost\":0.002},
      {\"seq\":2,\"ts\":$((NOW + 1000)),\"provider\":\"deepseek-official\",\"model\":\"deepseek-v4.1-flash\",\"sessionId\":\"curl-s1\",\"purpose\":\"demo\",
       \"tokens\":{\"input\":1500,\"output\":700,\"cacheRead\":0,\"cacheWrite\":0,\"reasoning\":0},\"cost\":0.0036}]}"; echo

echo
echo "== 5. 水位 /api/v1/ingest/watermark =="
curl -sS "$BASE/api/v1/ingest/watermark?source=$SOURCE&deviceId=$DEVICE_ID" \
  -H "authorization: Bearer $TOKEN"; echo

echo
echo "完成。打开看板「设备 × Agent」页应能看到本次上报。"
