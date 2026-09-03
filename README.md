# obniz 傘お知らせ

1時間おきに、現在時刻〜当日24時までの降水確率を確認し、30%以上の時間帯が一つでもあればobniz + HT16K33 8x8マトリクスに傘マークを表示する。JST 0時〜5時台はスリープ(消灯)。

## 配線

obnizBoardには専用のVCC/GNDピンがないため、io0〜io3の4本をHT16K33に接続する。

| HT16K33 | obniz |
|---|---|
| SCL | io0 |
| SDA | io1 |
| VCC | io2 |
| GND | io3 |

電源(io2=5V出力, io3=GND)はコードが起動時に自動設定する。

## セットアップ手順

1. このリポジトリをGitHubに作成しpush
2. リポジトリの Settings > Secrets and variables > Actions を開く
   - **Secrets**: `OBNIZ_ID`(例: `xxxx-xxxx`)
   - **Variables**(任意、未設定でも動作):
     - `AREA_CODE`: 気象庁地域コード(デフォルト`130000`東京地方)
     - `POP_THRESHOLD`: 傘表示の降水確率閾値%(デフォルト`30`)
3. Actions タブで `Morning Umbrella Notice` を手動実行(workflow_dispatch)して動作確認

## 動作ロジック

- JST 0:00〜5:59 → 判定せず消灯
- それ以外の時間 → 気象庁APIで、現在時刻〜当日24:00までの3時間区切り降水確率を確認
  - いずれかの時間帯で閾値(デフォルト30%)以上 → 傘マーク点灯
  - すべて閾値未満 → 消灯
- 上記を毎時0分(JST)に実行し、表示を更新

## 地域コードの調べ方

https://www.jma.go.jp/bosai/forecast/ で対象地域を選択した際のURL末尾6桁の数字。

## ローカルテスト

```bash
npm install
OBNIZ_ID=xxxx-xxxx AREA_CODE=130000 npm start
```
