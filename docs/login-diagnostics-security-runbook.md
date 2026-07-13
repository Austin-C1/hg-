# 登录诊断安全清理

当前登录诊断只保存安全摘要，不保存 cookie、storageState、密码、输入值、页面正文或截图。历史目录可能仍包含旧 `snapshot.json`、截图或其他敏感附件；项目不会自动删除这些本地文件。

默认命令只做 dry-run，不改文件，也不输出诊断内容或绝对路径：

```powershell
npm run crown:login-diagnostics:cleanup
```

检查其他明确的诊断根目录：

```powershell
npm run crown:login-diagnostics:cleanup -- --dir D:\safe-copy\login-diagnostics
```

实际清理属于删除和覆盖操作，必须先取得用户对目标目录的明确授权。获批后才可执行：

```powershell
npm run crown:login-diagnostics:cleanup -- --dir D:\approved\login-diagnostics --apply
```

`--apply` 只允许作用于名为 `login-diagnostics` 的目录，不跟随目录链接；它会原子重写每个 `snapshot.json` 为安全 schema，并删除同一诊断子目录中的截图和其他附件。重复执行保持幂等。

如果历史诊断曾保存真实凭据或 session 材料，清理文件后仍必须：

1. 轮换受影响的皇冠账号密码；
2. 失效相关 session、cookie 和 token；
3. 检查备份、同步盘和历史镜像中是否仍有副本；
4. 在完成轮换前不要恢复真实执行权限。

本次开发和自动测试只操作系统临时目录，没有对项目实际 `data/runtime/login-diagnostics` 执行 `--apply`。
