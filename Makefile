# mergelens — 常用操作入口
# 用法示例：
#   make install
#   make test
#   make review P=my-group/my-repo MR=42        （dry-run，不发布）
#   make review-post P=my-group/my-repo MR=42   （正式发布评论）
#   make serve PORT=3000

REGISTRY ?= https://registry.npmmirror.com
PROXY    ?=                       # 代理环境下传 PROXY=http://host:port
PORT     ?= 3000
NPM_FLAGS = --registry=$(REGISTRY) $(if $(PROXY),--proxy=$(PROXY) --https-proxy=$(PROXY))

.PHONY: install typecheck test build review review-post serve config clean

install:            ## 安装依赖（默认走 npmmirror 镜像）
	npm install $(NPM_FLAGS)

typecheck:          ## TypeScript 类型检查
	npx tsc --noEmit

test: typecheck     ## 类型检查 + 单元测试
	npx tsx tests/run.ts

build:              ## 编译到 dist/
	npx tsc

review:             ## dry-run 审查：make review P=<project> MR=<iid>
	@test -n "$(P)" -a -n "$(MR)" || (echo "用法：make review P=my-group/my-repo MR=42" && exit 2)
	npx tsx src/cli.ts review $(P) $(MR) --dry-run

review-post:        ## 正式审查并发布评论：make review-post P=<project> MR=<iid>
	@test -n "$(P)" -a -n "$(MR)" || (echo "用法：make review-post P=my-group/my-repo MR=42" && exit 2)
	npx tsx src/cli.ts review $(P) $(MR)

serve:              ## 启动 Webhook 服务：make serve PORT=3000
	npx tsx src/cli.ts serve --port $(PORT)

config:             ## 打印生效配置（脱敏）
	npx tsx src/cli.ts config

clean:
	rm -rf dist node_modules
