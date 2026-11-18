# POS 商品圖片庫部署

業務 Excel 填寫的是 `item.code`（例如 `BD-101643`），不是數字 productid。欄名支援 `code`、`Code`、`CODE`、`商品編號`、`商品编号`、`SKU`。程式先按 code 參數查詢 item，再用查到的 id 關聯 B 類條碼、匹配圖片。code 查無或重複時會報錯。舊版 productid 匯入仍保留相容性；兩者都有時以 code 為準。

程式在 192.168.101.249 運行。Windows 圖片來源由伺服器掛載，程式不使用 Windows 磁碟機代號，也不保管 SMB 密碼。

- 街貨：`T:\MKT\Public Share\Product Photo Server\Server_product`
- 倉貨：`T:\Warehouse\Public Share\01 Products_Photo`

在伺服器 `.env` 設定以下項目（SQL 密碼使用實際值）：

```dotenv
MSSQL_HOST=192.168.1.200
MSSQL_PORT=2468
MSSQL_DATABASE=pos6
MSSQL_USERNAME=ciao_user
MSSQL_PASSWORD=填寫SQL密碼
POS_BARCODE_COLUMN=Barcode
PRODUCT_PHOTO_STREET_HOST_PATH="/mnt/244/MKT/Public Share/Product Photo Server/Server_product"
PRODUCT_PHOTO_WAREHOUSE_HOST_PATH="/mnt/244/Warehouse/Public Share/01 Products_Photo"
```

`POS_BARCODE_COLUMN` 須與 `dbo.item_barcode` 的實際條碼欄位名稱一致。SQL 帳號只需讀取 `dbo.item` 與 `dbo.item_barcode`。目前按 `item.id = productid`，以 `item_barcode.Item_ID = item.id AND type IN ('B', 'b')` 查詢，取 `item.code`、`item.name1` 和條碼。SQL 使用參數傳值。

```bash
docker compose up -d --build
```

服務仍使用 `6695` 埠。掛載為唯讀，目錄不存在時不會建立空資料夾偽裝成掛載成功。圖片目錄已包含在主配置 `compose.yaml`，不再需要額外的 `-f` 參數；原有雙配置命令仍相容。以上 `/mnt/244` 路徑是 Linux 伺服器的掛載目錄，本機 Mac 開發時須將兩個 HOST_PATH 改為本機實際可讀取的圖片目錄。

下載新 Excel 模板，填寫 `code`（例如 `BD-101643`），商品名稱可留空。保留活動名稱、優惠總價、優惠件數、開始／結束日期及門店欄位。價格來自 Excel，不從 POS 覆蓋。支援 xlsx 與 UTF-8 CSV，舊 xls 請另存 xlsx。

圖片按 productid、code 或 B 類條碼匹配。支援相同名稱的目錄、完整檔名，以及以空格、底線或括號分隔的檔名，例如 `4837.jpg`、`BD-101643.png`、`BD-101643_正面.jpg`、`BD-101643/正面.jpg`。不按近似商品名稱猜圖，`4837` 不會命中 `14837`；暫不把連字號當成後綴分隔，以免截短商品 code。請依實際檔名確認規則。

兩個目錄均掃描，索引快取一小時並保存至資料卷，容器重啟可重用有效索引；首次讀取仍需列出共享目錄，新增圖片最遲於快取更新後出現。唯一圖片自動選中，多張圖片顯示街貨／倉貨與相對路徑供業務選擇；找不到圖片可使用已上傳素材。POS 查無商品或連線失敗會明確報錯。圖片接口需要登入，不能傳任意檔案路徑。支援 JPG/PNG/WebP/TIFF/BMP，傳送前縮至最長邊 2000px 並轉 PNG；適合編輯，需大尺寸印刷時請核對圖片解析度。

預覽確認前不把整個圖片庫下載到瀏覽器。確認後只下載選中的圖片，將影像快照、商品編號及內部 productid 保存到專案素材庫，避免歷史海報受共享目錄變動影響。

## 同一行放兩件商品

`code` 填第一件商品編號，`code2` 選填第二件商品編號。一行仍對應一個商品組／海報格，兩張圖片一起放入，可在編輯器繼續調整。兩件商品分別查詢及選圖；任一件缺圖時不能直接生成。名稱可自行填寫組合名稱，留空時合併兩個 POS 名稱。規格、優惠總價、優惠件數均使用該行資料，不會因放入兩張圖片自動改價或改件數。重新下載模板可取得 `code2` 欄。
