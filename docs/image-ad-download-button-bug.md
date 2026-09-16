# 无视频广告错误显示下载按钮：卡片边界越界

## 现象

部分图片广告没有 `<video>` 标签，右上角菜单中仍然出现“下载视频”。点击后还可能使用页面中另一条广告的档案库编号，打开错误的详情页。

现场复现使用的图片广告编号为 `1720202429228436`：

- 当前广告卡片包含 1 个档案库编号和 0 个 `<video>`。
- 菜单中已经插入 `.fo-facebook-ad-video-menu-item`。
- `findAdCard()` 最终返回的祖先容器包含 115 个档案库编号和 163 个 `<video>`。
- 该容器提取到的第一个编号是 `1919390142798191`，与当前广告不一致。

## 原因

`findAdCard()` 从菜单触发按钮向上查找祖先。当前逻辑把“找到档案库编号”和“找到视频”作为同一个返回条件：

```js
while (current && current !== document.body) {
  if (extractLibraryId(current)) {
    candidate = current;
    if (current.querySelector(VIDEO_SELECTOR)) {
      return current;
    }
  }
  current = current.parentElement;
}
```

视频广告会在广告卡片范围内满足这两个条件。图片广告在卡片范围内找不到视频，循环继续向上进入整个搜索结果列表。结果列表包含其他视频广告，因此 `current.querySelector(VIDEO_SELECTOR)` 返回元素，函数把列表容器当成当前广告卡片。

`getVideoAdId()` 随后在同一个列表容器中再次检查视频并提取第一个编号，两个检查使用了相同的错误范围，无法拦截这个误判。

## 解决方法

卡片定位和媒体检测需要分成两个步骤：

1. 根据档案库编号确定当前广告卡片的边界。
2. 只在这个卡片范围内检查视频。

### 限定卡片边界

从菜单触发按钮向上遍历时，统计每个祖先中出现的唯一档案库编号：

- 没有编号时继续向上。
- 只有一个编号时记录为当前候选卡片。
- 出现两个或更多编号时已经进入列表容器，停止遍历并返回上一个候选卡片。

实现结构如下：

```js
function findAdCard(menu) {
  const layer = menu.closest('[data-ownerid]');
  const ownerId = layer && layer.getAttribute('data-ownerid');
  const trigger = ownerId && document.getElementById(ownerId);
  let current = trigger;
  let card = null;

  while (current && current !== document.body) {
    const ids = extractLibraryIds(current);

    if (ids.length > 1) {
      break;
    }

    if (ids.length === 1) {
      card = current;
    }

    current = current.parentElement;
  }

  return card;
}
```

`extractLibraryIds()` 应遍历独立文本节点，使用现有多语言规则提取编号，并通过 `Set` 去重。同一个编号可能出现在多层包装元素的 `textContent` 中，唯一编号数量应按编号值计算。

### 在卡片内检测视频

卡片边界确定后，下载入口继续使用当前检查：

```js
function getVideoAdId(card) {
  if (!card || !card.querySelector(VIDEO_SELECTOR)) return '';
  return extractLibraryId(card);
}
```

图片广告卡片返回空字符串，菜单不会插入下载入口。视频广告和同一档案库编号下包含视频的组合广告仍会显示入口。

## 回归测试

现有图片广告测试只构造了一张独立卡片，没有共享的列表父容器，因此无法复现越界查找。新的测试夹具需要包含：

```text
搜索结果列表
├── 图片广告卡片：1 个编号，0 个 video
└── 视频广告卡片：1 个编号，1 个 video
```

至少覆盖以下断言：

1. 从图片广告菜单调用 `findAdCard()` 时返回图片广告卡片。
2. 图片广告的 `getVideoAdId()` 返回空字符串。
3. 从视频广告菜单调用 `findAdCard()` 时返回视频广告卡片。
4. 视频广告的 `getVideoAdId()` 返回自身编号。
5. 搜索结果列表中的其他视频不会影响图片广告的判断。
6. 英文、简体中文和繁体中文编号继续通过现有测试。

修复完成后，图片广告菜单中应只有 Facebook 原生选项；视频广告菜单中应保留“下载视频”，并使用当前卡片的档案库编号打开详情页。
