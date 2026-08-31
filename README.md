# PhuThuy3D WebGL

## Game URL

[https://denispham1107.github.io/game3d/](https://denispham1107.github.io/game3d/)

## Repository

[https://github.com/denispham1107/game3d](https://github.com/denispham1107/game3d)

## Deployment

Unity WebGL + GitHub Pages + PWA. GitHub Actions chuẩn bị các asset WebGL không nén, kiểm tra header `.data`/`.wasm`, rồi deploy artifact lên GitHub Pages.

Build nguồn có thể dùng Brotli (`.br`) hoặc Unity Decompression Fallback (`.unityweb`). Asset lớn được chia thành các phần dưới 50 MiB; workflow tự ghép, giải nén và đổi về `.data`/`.wasm`/`.js` trước khi deploy. Cách này tránh bộ giải nén JavaScript giữ đồng thời hai buffer rất lớn trong RAM, đặc biệt quan trọng với Safari trên iPhone/iPad. Website không phụ thuộc `play.unity.com`.

Trên iOS/iPadOS, wrapper không lưu bản sao Unity `.data` vào Cache Storage, khởi tạo ở DPR 1 rồi tự nâng theo DPR của thiết bị với mức tối đa DPR 2 và ngân sách điểm ảnh. Android cũng tối đa DPR 2; desktop dùng DPR mặc định của trình duyệt. Service worker chỉ cập nhật sau khi game khởi tạo. Cách này giữ hình ảnh sắc nét mà vẫn giảm đỉnh RAM lúc tải, nhưng không thể thay thế việc tối ưu project Unity: nếu `.data` tiếp tục tăng, nên chuyển asset lớn sang Addressables/AssetBundles và chỉ tải khi cần.

## Cách cập nhật game

1. Build lại game từ Unity sang WebGL.
2. Đưa ZIP WebGL mới vào thư mục repository này.
3. Yêu cầu Codex cập nhật bản Unity WebGL mới nhất.
4. Codex chạy `scripts/import-unity-build.ps1`; script tự chọn ZIP mới nhất, giải nén và xác định WebGL root.
5. Script chỉ thay `Build/`, `TemplateData/`, `StreamingAssets/` và `ProjectVersion.txt`; wrapper PWA/GitHub Pages được giữ nguyên.
6. Script cập nhật cấu hình asset, cache version, chia file lớn và tạo `_site` để kiểm tra.
7. Codex kiểm tra diff, commit, push `main`; GitHub Pages tự deploy.

Có thể chạy thủ công từ PowerShell:

```powershell
.\scripts\import-unity-build.ps1
```

ZIP là input cục bộ và được `.gitignore` bỏ qua. Script mặc định dừng nếu repository có thay đổi chưa commit để bảo vệ bản đang chạy.

## Cấu trúc quan trọng

- `index.html`, `styles/game-shell.css`: WebGL wrapper responsive/fullscreen.
- `manifest.webmanifest`, `sw.js`, `icons/`: PWA cho iOS, Android và desktop.
- Tên và icon web/PWA là `PhuThuy3D`; script cập nhật giữ thương hiệu này ngay cả khi ZIP Unity còn dùng tên Player Settings cũ.
- `unity-build-config.js`, `unity-assets.json`: cấu hình build được sinh tự động; cấu hình runtime cũng được nhúng vào `index.html` để tránh cache mismatch.
- `Build/`, `TemplateData/`, `StreamingAssets/`: runtime Unity.
- `.github/workflows/deploy-pages.yml`: build và deploy GitHub Pages.
- `scripts/prepare-pages.mjs`: ghép, giải nén và kiểm tra artifact Pages.
- `scripts/import-unity-build.ps1`: quy trình cập nhật ZIP trong tương lai.
