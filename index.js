const Obniz = require("obniz");

// ===== 設定 =====
const OBNIZ_ID = process.env.OBNIZ_ID; // 例: "xxxx-xxxx"
const AREA_CODE = process.env.AREA_CODE || "130000"; // 気象庁 地域コード（デフォルト:東京）
const POP_THRESHOLD = Number(process.env.POP_THRESHOLD || 30); // 降水確率の閾値(%)
const I2C_ADDRESS = Number(process.env.HT16K33_ADDR || 0x70);
const SCL_PIN = Number(process.env.SCL_PIN || 0);
const SDA_PIN = Number(process.env.SDA_PIN || 1);
const VCC_PIN = Number(process.env.VCC_PIN || 2);
const GND_PIN = Number(process.env.GND_PIN || 3);
const SLEEP_START_HOUR = 0; // JST 0時〜
const SLEEP_END_HOUR = 6; // 6時未満(=5時台まで)は消灯

// ===== アイコン定義（上から下・左から右、1=点灯） =====
const ICON_UMBRELLA = [
  [0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 1, 1, 1, 0, 0, 0],
  [0, 1, 1, 1, 1, 1, 0, 0],
  [1, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 0, 1, 0, 0, 0, 0],
  [0, 0, 1, 1, 0, 0, 0, 0],
  [0, 0, 0, 1, 0, 0, 0, 0],
];

const ICON_SMILE = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 1, 0, 0, 0, 1, 0, 0],
  [1, 0, 1, 0, 1, 0, 1, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 1, 0, 0, 0, 1, 0, 0],
  [0, 0, 1, 0, 1, 0, 0, 0],
  [0, 0, 0, 1, 0, 0, 0, 0],
];

// 雨予報なし時の控えめな表示(右下1ドットのみ)
const ICON_NO_RAIN = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 1],
];

const ICON_CLEAR = new Array(8).fill(new Array(8).fill(0));

// 実機は「1バイト=1列」「ビット7=一番上の行、ビット0=一番下の行」のため変換する
function bitmapToHardwareBytes(bitmap) {
  const bytes = new Array(8).fill(0);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      if (bitmap[row][col]) {
        bytes[col] |= 1 << (7 - row);
      }
    }
  }
  return bytes;
}

// ===== 現在時刻(JST)関連 =====
function getJstNow() {
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC+9をUTC表現に載せる
}

function isSleepTime(jstNow) {
  const hour = jstNow.getUTCHours();
  return hour >= SLEEP_START_HOUR && hour < SLEEP_END_HOUR;
}

// 翌日0時(JST)を実時刻(Date)で返す
function getNextMidnightJstAsRealDate(jstNow) {
  const y = jstNow.getUTCFullYear();
  const m = jstNow.getUTCMonth();
  const d = jstNow.getUTCDate();
  const nextMidnightShifted = Date.UTC(y, m, d + 1, 0, 0, 0);
  return new Date(nextMidnightShifted - 9 * 60 * 60 * 1000);
}

// ===== 気象庁APIから、今〜翌日0時までの間に閾値以上の降水確率があるか判定 =====
async function fetchNeedUmbrella(areaCode, thresholdPct) {
  const url = `https://www.jma.go.jp/bosai/forecast/data/forecast/${areaCode}.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`JMA API error: ${res.status}`);
  }
  const data = await res.json();

  const popSeries = data[0].timeSeries.find(
    (t) => t.areas[0].pops !== undefined
  );
  if (!popSeries) throw new Error("降水確率データが見つかりません");

  const timeDefines = popSeries.timeDefines.map((t) => new Date(t));
  const pops = popSeries.areas[0].pops.map(Number);

  const now = new Date();
  const nextMidnight = getNextMidnightJstAsRealDate(getJstNow());

  let maxPop = 0;
  let hit = false;
  for (let i = 0; i < pops.length; i++) {
    const start = timeDefines[i];
    const end = new Date(start.getTime() + 3 * 60 * 60 * 1000); // 3時間区切りの想定
    const overlapsRemainingToday = end > now && start < nextMidnight;
    if (overlapsRemainingToday) {
      maxPop = Math.max(maxPop, pops[i]);
      if (pops[i] >= thresholdPct) hit = true;
    }
  }

  console.log(
    `本日0時までの残り時間帯で最大降水確率${maxPop}% (閾値${thresholdPct}%) → ${
      hit ? "傘マーク表示" : "消灯"
    }`
  );
  return hit;
}

// ===== HT16K33制御 =====
class HT16K33Matrix {
  constructor(obniz, address, scl, sda) {
    this.obniz = obniz;
    this.address = address;
    this.i2c = obniz.getFreeI2C();
    this.i2c.start({ sda, scl, mode: "master", clock: 100000 });
  }

  init() {
    this.i2c.write(this.address, [0x21]); // 発振器ON
    this.i2c.write(this.address, [0x81]); // 表示ON, 点滅なし
    this.i2c.write(this.address, [0xef]); // 輝度最大(0xE0 | 0-15)
  }

  draw(bitmap) {
    const bytes = bitmapToHardwareBytes(bitmap);
    const data = [0x00];
    for (const b of bytes) {
      data.push(b, 0x00);
    }
    this.i2c.write(this.address, data);
  }
}

// ===== メイン処理 =====
async function main() {
  if (!OBNIZ_ID) throw new Error("環境変数 OBNIZ_ID が未設定です");

  const jstNow = getJstNow();
  const sleeping = isSleepTime(jstNow);

  let needUmbrella = false;
  if (sleeping) {
    console.log(
      `現在JST${jstNow.getUTCHours()}時台のためスリープ時間帯 → 消灯`
    );
  } else {
    needUmbrella = await fetchNeedUmbrella(AREA_CODE, POP_THRESHOLD);
  }

  const obniz = new Obniz(OBNIZ_ID);
  await obniz.connectWait();
  obniz.resetOnDisconnect(false); // 切断後もIO状態(電源・表示)を保持する

  // io2を5V出力、io3をGNDとして使用(obnizBoardには専用電源ピンがないため)
  obniz[`io${VCC_PIN}`].drive("5v");
  obniz[`io${VCC_PIN}`].output(true);
  obniz[`io${GND_PIN}`].output(false);

  const matrix = new HT16K33Matrix(obniz, I2C_ADDRESS, SCL_PIN, SDA_PIN);
  matrix.init();
  matrix.draw(sleeping ? ICON_CLEAR : needUmbrella ? ICON_UMBRELLA : ICON_NO_RAIN);

  await obniz.wait(1000);
  await obniz.closeWait();
}

main()
  .then(() => {
    console.log("完了");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
