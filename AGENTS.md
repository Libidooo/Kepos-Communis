# 本工作区如何运转

工作目录：`T:\Kepos`

这个工作区由 Kepos Communis 驱动：一位总理（主 Agent）把任务分派给多名只读代表，
代表可以派生僚属，并对僚属的结果负责。所有产出都留档，不依赖会话上下文存活。

## 归档结构

全部运行时产物在 `.kepos/`，与源码分开，不干扰阅读项目本身：

- `profiles/*.md` —— 代表档案（frontmatter + 职责正文），可读可改
- `<taskId>/brief.md` —— 任务说明与授权范围
- `<taskId>/transcript.md` —— 执行过程（结论之前的全部内容）
- `<taskId>/report.md` —— 结论（输出契约的 `## 结论` 一节起）
- `<taskId>/decision.md` —— 直属代表对该报告的裁决
- `index.json` —— 任务索引

## 代表

- **策略官** · strategist · deepseek-v4.1-flash-1017
- **勘察官** · surveyor · deepseek-v4.1-flash-1017
- **工程官** · engineer · deepseek-v4.1-flash-1017
- **审查官** · auditor · deepseek-v4.1-flash-1017
- **核验官** · verifier · deepseek-v4.1-flash-1017
- **哨卫** · sentinel · deepseek-v4.1-flash-1017
- **记录官** · scribe · deepseek-v4.1-flash-1017
- **协调官** · mediator · deepseek-v4.1-flash-1017
- **档案官** · archivist · deepseek-v4.1-flash-1017
- **制图官** · cartographer · deepseek-v4.1-flash-1017
- **软件架构官** · software_architect · deepseek-v4.1-flash-1017
- **代码评审官** · code_reviewer · deepseek-v4.1-flash-1017
- **测试策略官** · test_strategist · deepseek-v4.1-flash-1017
- **质量工程官** · qa_engineer · deepseek-v4.1-flash-1017
- **安全工程官** · security_engineer · deepseek-v4.1-flash-1017
- **运维工程官** · devops_engineer · deepseek-v4.1-flash-1017
- **性能工程官** · performance_engineer · deepseek-v4.1-flash-1017
- **重构规划官** · refactoring_planner · deepseek-v4.1-flash-1017
- **法律顾问** · legal_counsel · deepseek-v4.1-flash-1017
- **合同审查官** · contract_reviewer · deepseek-v4.1-flash-1017
- **合规审查官** · compliance_officer · deepseek-v4.1-flash-1017
- **隐私与数据官** · privacy_officer · deepseek-v4.1-flash-1017
- **知识产权官** · ip_officer · deepseek-v4.1-flash-1017
- **学术编辑** · academic_editor · deepseek-v4.1-flash-1017
- **发表准备审查官** · publication_readiness_auditor · deepseek-v4.1-flash-1017
- **投稿编辑官** · submission_editor · deepseek-v4.1-flash-1017
- **政策简报编辑官** · policy_brief_editor · deepseek-v4.1-flash-1017
- **审稿回复官** · peer_response_officer · deepseek-v4.1-flash-1017
- **研究架构官** · research_architect · deepseek-v4.1-flash-1017
- **文献策略官** · literature_strategist · deepseek-v4.1-flash-1017
- **来源核验官** · source_verifier · deepseek-v4.1-flash-1017
- **方法论官** · methodologist · deepseek-v4.1-flash-1017
- **统计审查官** · statistical_reviewer · deepseek-v4.1-flash-1017
- **伦理审查官** · ethics_reviewer · deepseek-v4.1-flash-1017
- **同行评议官** · peer_reviewer · deepseek-v4.1-flash-1017
- **反方论证官** · devils_advocate · deepseek-v4.1-flash-1017
- **可复现性审查官** · reproducibility_auditor · deepseek-v4.1-flash-1017
- **政策研究官** · policy_researcher · deepseek-v4.1-flash-1017
- **政策分析官** · policy_analyst · deepseek-v4.1-flash-1017
- **监管监测官** · regulatory_monitor · deepseek-v4.1-flash-1017
- **政策影响评估官** · impact_assessor · deepseek-v4.1-flash-1017
- **利益相关者分析官** · stakeholder_mapper · deepseek-v4.1-flash-1017
- **政策咨询评议官** · consultation_reviewer · deepseek-v4.1-flash-1017
- **工具操作官** · toolsmith · deepseek-v4.1-flash-1017
- **数据分析官** · data_analyst · deepseek-v4.1-flash-1017
- **依赖构建官** · dependency_engineer · deepseek-v4.1-flash-1017
- **故障调查官** · incident_investigator · deepseek-v4.1-flash-1017
- **完整性守门官** · integrity_gatekeeper · deepseek-v4.1-flash-1017

## 约定

- 代表只读；写操作必须经人类批准并绑定到单次任务，任务结束即失效。
- 代表之间的证据不互读；同一工作小组内可读彼此证据，但结论各自独立。
- 僚属不读其他任务的归档，也不读本目录之外的代表配置。
- 记忆是双时态的：修正只标记失效，不删除，历史可回溯。
- 任务完成不等于验收通过：计划步骤带 acceptance 条目，未勾满会记为 premature_done。
