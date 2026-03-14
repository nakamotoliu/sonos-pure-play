# OSS_ALLOWLIST

This file documents intentional exceptions that are allowed during OSS checks.

## Allowed examples
- `https://play.sonos.com/...` URLs used as public product entry points
- Chinese UI labels such as `更多选项`, `替换队列`, `立即播放`, because they are product UI strings rather than private data
- Generic Chinese room words in parser heuristics, such as `客厅`, `卧室`, `厨房`, `书房`, when used as language heuristics rather than as user-specific device names

## Not allowed
- personal filesystem paths
- local wiki paths
- machine names
- private account identifiers
- personal room/device names discovered from one specific environment
