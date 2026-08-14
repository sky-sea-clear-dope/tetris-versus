// おじゃまブロックの量を人数に合わせて調整する係数。
// サーバー本体とテストの両方から読むので、別ファイルにしてある。

/**
 * 人数が増えるほど、1回の攻撃で送るおじゃまを減らす。
 * 3人・4人だと四方から飛んでくるので、そのままの威力だと一瞬で埋まってしまう。
 */
export function garbageScale(livingCount) {
  if (livingCount >= 4) return 0.6;
  if (livingCount === 3) return 0.75;
  return 1;
}

/** 実際に送る段数（かならず1段以上） */
export function scaleGarbage(lines, livingCount) {
  return Math.max(1, Math.round(lines * garbageScale(livingCount)));
}
