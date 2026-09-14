# Facebook Ads Library 视频下载助手

一个油猴脚本，用于在 Facebook Ads Library 的视频广告菜单中增加视频下载入口。

## 安装

先安装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey，然后打开部署后的用户脚本地址：

```text
https://facebook-monkey-toolkit.d2bot/facebook-ad-video-downloader.user.js
```

确认安装后，刷新 Facebook Ads Library 页面即可。

## 使用

1. 打开 Facebook Ads Library。
2. 打开视频广告右上角的下拉菜单。
3. 点击“下载视频”。
4. 选择视频版本，脚本会在新标签页打开视频链接。

## Cloudflare Pages 部署

将 `public` 目录部署到 Cloudflare Pages，构建命令留空，输出目录填写：

```text
public
```

可以使用 Cloudflare Pages 的 GitHub 集成自动部署，也可以使用 Direct Upload。

- [Pages Git 集成](https://developers.cloudflare.com/pages/get-started/git-integration/)
- [Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)

## 文件说明

- `public/facebook-ad-video-downloader.user.js`：用户脚本
- `sample.js`：视频链接解析示例
