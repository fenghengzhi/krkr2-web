# 固定兼容样本

这些文件用于 GitHub Actions 的原 KAG 和真实旧/新版本升级验证，不随播放器发布。原始本地历史目录保留，压缩包只封装文件，不修改旧应用、manifest 或 ABI 值。

| 文件                | 来源                                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kag3_template.xp3` | [kirikiroid2-web 的固定提交](https://github.com/fenghengzhi/kirikiroid2-web/blob/13dda190f8370d02b6cf59286a088529b355658c/tests/test_files/xp3/kag3_template.xp3) |
| `kag3_template.zip` | 此前 ZIP 阶段的无损重打包；30 个成员的长度、SHA-256 与原 XP3 哈希记录在相邻 JSON 中                                                                               |
| `tjs-abi1.tar.gz`   | System 事件阶段保留的完整 TJS ABI 1 发布，build `af931e99383f099685e36ea8d382f57a2bb65de966833dd13bf6e49276ea27ed`                                                |
| `font-abi1.tar.gz`  | 纵排阶段保留的字体 ABI 1 发布，build `336c04ffdbdb20209c7057c79861a7c9e214294533e2cf62d23565dcebfbd479`                                                           |
| `tjs-abi2.tar.gz`   | VM 控制台阶段保留的 TJS ABI 2 发布，build `9a29e94ad434d349d14f2bf24a2f52f142ecabfcf0517cf586b4ddb6c51cf096`                                                      |

KAG 模板保留原作者声明：Copyright (C) 2001–2009, W.Dee and contributors；脚本头声明允许修改与分发。没有包含商业游戏。旧发布中的第三方许可证仍在包内。

`tjs-abi3.tar.gz` 来自 [完整回归 34809918318](https://github.com/fenghengzhi/krkr2-web/actions/runs/34809918318) 的 `test-build/dist`，对应 build `2870471a3ad6c07f7420962f81702eed2727a3ba6919c08f20bd7425f763771a`。文件树由 VM 控制台阶段最终云端矩阵固定，用于随后 ABI 4 的真实离线升级验证；封装没有改动旧应用或 manifest。

`manifest.json` 固定压缩包哈希、逐文件树哈希和历史构建标识。CI 先校验压缩包，安全解包后再校验全部旧发布文件、离线资源清单、build token 和真实 ABI；ZIP 成员还由 Python 标准库读取并核对 CRC/长度/摘要。验证脚本不在本地执行。
