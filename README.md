# 📚 Zotero Paper Hub

基于个人 Zotero 文献库构建的静态文献检索与追溯站点，部署于 GitHub Pages。

**访问地址**：https://SZY12021130.github.io/zotero-paper-hub/

## ✨ 功能

- **概览仪表盘**：年度发文分布、文献类型、高产作者 / 高频标签 / 收藏夹分布图表
- **多字段模糊查询**：支持 `title:` `author:` `venue:` `tag:` `doi:` `year:2019-2024` 前缀与短语精确匹配（引号），摘要可参与搜索
- **排序与分页**：按年份 / 标题 / 作者 / 期刊 / 入库时间排序，分页浏览
- **分类浏览**：Zotero 收藏夹层级 + 标签双维度筛选，期刊/会议、作者、标签索引页
- **作者追溯**：作者页展示其全部论文、逐年发文曲线、主要合作者
- **题目追溯**：论文详情页内置本地相似度（词袋余弦）+ OpenAlex 相似研究检索
- **引用追溯**：通过 OpenAlex 获取引用本文的文章列表，并绘制引用网络力图
- **GitHub 开源匹配**：自动识别元数据中的仓库链接；详情页可按标题实时搜索 GitHub 仓库（可在页面输入 Token 提升 API 限额，仅保存在浏览器本地）

## 🔄 更新数据

Zotero 中新增文献后，重新运行导出脚本即可：

```bash
# 复制数据库快照（Windows 路径按实际修改）
cp "$USERPROFILE/Zotero/zotero.sqlite" zotero_snapshot.sqlite
python export_papers.py
# 然后提交推送
git add data/papers.json && git commit -m "update data" && git push
```

## 🏗 结构

```
├── index.html            # 单页应用入口
├── assets/
│   ├── app.js            # 搜索/路由/视图/图表/API 集成
│   └── style.css
├── data/papers.json      # 由 export_papers.py 生成的文献数据
├── export_papers.py      # Zotero sqlite -> papers.json 导出脚本
└── README.md
```

纯静态站点，无构建步骤。搜索、筛选、分页、作者追溯完全在浏览器本地完成；引用追溯 / 相似研究 / GitHub 检索分别调用 OpenAlex 与 GitHub 公开 API（需联网）。
