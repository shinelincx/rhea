# Rhea 儿童安全求助的升级与监护人通知基线

- 状态：建议作为跨地区产品基线；不是任何司法辖区的法律意见
- 研究日期：2026-09-03
- 决策票据：[GitHub Issue #13](https://github.com/shinelincx/rhea/issues/13)
- 适用范围：学习者在 AI 导师中披露自伤风险、虐待、霸凌或紧迫危险，以及系统需要决定是否通知监护人、平台人员或外部机构的场景

## 结论

Rhea 应把这类交互定义为**安全升级**，而不是继续由 AI 导师进行普通学习对话。可以自动执行的动作应限于低后悔、可逆的即时保护：停止普通生成，不评价真伪，以简短适龄语言回应，询问学习者是否正处于即时危险，提示去更安全且有人在的地方，并展示经过属地核验的可信成年人、儿童热线、危机热线和紧急服务入口。WHO 的危机指引将生命危险、不得独处、寻求医院或紧急服务与非紧迫情况下的持续专业支持区分开；UNICEF 也要求面向儿童的 AI 建立危机协议、情境化转介路径，并在高风险交互中触发内部升级、复核或暂停对话。[WHO 自杀危机指引](https://www.emro.who.int/mhps/suicide.html)；[UNICEF 面向 AI 聊天机器人的企业建议（2026）](https://www.unicef.org/media/181136/file/UNICEF-When-AI-becomes-friend-Business-recommendations-2026.pdf)

Rhea **不得默认、即时、自动通知监护人**。通知前必须由受过儿童保护培训的人员判断该监护人是否是安全的非涉害照护者、通知是否会增加报复或其他伤害、学习者知道将共享什么，以及属地法律是否要求或允许这样做。若披露指向监护人或学习者表示不信任该监护人，应禁止系统通知该人，改为引导其他可信成年人、儿童热线或法定儿童保护渠道，并由人工依属地流程决定进一步披露。UNICEF 的儿童保护沟通规范要求不让儿童面对其不信任的人、不让疑似施害者参与会谈，并仅考虑“非涉害照护者”；联合国《数字环境中的儿童权利一般性意见第 25 号》同时警告，不当的监护人监控可能妨碍儿童访问热线或查找敏感求助信息。[UNICEF CCS 指南，第 75 页相关规范](https://www.unicef.org/media/155226/file/CCS%20Guidelines%20Final%20.pdf)；[联合国儿童权利委员会一般性意见第 25 号，第 69–76 段](https://docstore.ohchr.org/SelfServices/FilesHandler.ashx?enc=xfBzr2AVJ%2Fm%2FfXIEXW7hxTQrHodGBGQOLLAn9EXr%2BedAbHbjEePoBTI%2BN6n2B7SsntVQOGEX%2BbN2V0PM2w7hhQ%3D%3D)

AI 检测结果只能形成**安全信号**，不能成为虐待、自杀风险或可信度的诊断，也不能单独触发监护人通知、报警、法定报告或长期留档。澳大利亚 eSafety 的 Safety by Design 指南明确要求自动系统保持人工在环、向用户说明自动化的使用，并提供申诉；UNICEF 的 AI 指南要求监管、人工自主与监督、透明和问责，而且指出 AI 聊天机器人在危机级对话中可能给出危险或不恰当的临床回应。[eSafety Safety by Design 概览](https://www.esafety.gov.au/sites/default/files/2019-10/SBD%20-%20Overview%20May19.pdf?v=1720745795132)；[UNICEF《Guidance on AI and Children 3.0》](https://www.unicef.org/innocenti/media/11991/file/UNICEF-Innocenti-Guidance-on-AI-and-Children-3-2025.pdf)

这意味着：如果首发地区尚未建立经过法律审查的属地规则、受训人工安全复核、轮值时效和可用转介目录，Rhea 可以提供透明的自动即时安全提示，但**不得宣称自己会实时监控、联系救援或完成儿童保护报告**；也不应启用会暗示这类能力的产品文案。UNICEF 要求 AI 明确说明其非人类身份，不能被设计或营销为朋友、治疗师或可信密友；其企业建议还要求危机协议、情境化转介和可审计的风险缓解记录。[UNICEF 面向 AI 聊天机器人的企业建议（2026）](https://www.unicef.org/media/181136/file/UNICEF-When-AI-becomes-friend-Business-recommendations-2026.pdf)

## 跨地区基线原则

1. **儿童最大利益优先，但不抹去儿童的参与权与隐私权。** 儿童安全决策应同时考虑免受伤害、表达意见、隐私、年龄和发展能力；隐私干预必须合法、目的明确、数据最少、比例适当并服务于儿童最大利益。报告机制应安全、保密、及时、儿童友好且可访问。[联合国儿童权利委员会一般性意见第 25 号，第 13、19–20、44、69–76 段](https://docstore.ohchr.org/SelfServices/FilesHandler.ashx?enc=xfBzr2AVJ%2Fm%2FfXIEXW7hxTQrHodGBGQOLLAn9EXr%2BedAbHbjEePoBTI%2BN6n2B7SsntVQOGEX%2BbN2V0PM2w7hhQ%3D%3D)

2. **不承诺绝对保密，也不在尚未决定前威胁“告诉家长”。** 开始敏感交互时应以适龄语言说明：为了帮助其安全，极少数情况下可能需要把必要信息交给能提供帮助的人；若发生共享，应尽可能先告诉学习者共享对象、内容、原因和接下来会发生什么。儿童保护规范要求事先解释保密边界、让儿童参与报告过程，并避免做无法兑现的承诺。[Alliance CPHA《Inter-agency Guidelines for Case Management and Child Protection》2024，第 113 页相关规范](https://alliancecpha.org/sites/default/files/technical/attachments/Inter-agency%20Child%20Protection%20Case%20Management%20Guidelines_2nd%20Edition_2024.pdf)；[UNICEF CCS 指南](https://www.unicef.org/media/155226/file/CCS%20Guidelines%20Final%20.pdf)

3. **接纳披露，不审问、不判真假、不自行调查。** 自动回复应确认“谢谢你告诉我”“这不是你的错”“你值得得到帮助”，只收集完成即时安全路由所需的最少信息，不反复要求细节，也不联系或质问疑似施害者。UNICEF 指南要求认真、敏感地对待披露，避免审讯，且在采取报告、接触涉害者或医疗检查前向儿童解释过程；儿童保护政策也强调先确保安全，记录所听到的内容而非自行调查。[UNICEF 儿童暴力临床手册](https://www.unicef.org/cambodia/media/1366/file/Clinical%20Handbook%20English.pdf)；[UNICEF 保护儿童免受性虐待指南](https://www.unicef.org/egypt/sexual-abuse-children)

4. **紧迫程度决定响应速度，不决定披露是否“可信”。** 直接表示危险正在发生、生命可能马上受威胁，或现实中的暴力威胁，应进入最高优先级；系统先显示紧急求助与安全成年人入口，人工队列并行加急。非生命紧迫的自伤想法、虐待或霸凌仍应提供持续支持、报告/屏蔽工具和可信成年人或专业支持，但不应被错误包装为紧急救援。[WHO 自杀危机指引](https://www.emro.who.int/mhps/suicide.html)；[eSafety 用户安全与报告机制指南](https://www.esafety.gov.au/industry/safety-by-design/foundations/empowering-users-to-stay-safe-online)；[StopBullying.gov 网络霸凌报告指南](https://www.stopbullying.gov/cyberbullying/how-to-report)

5. **求助入口必须属地化、可用且在需要时出现。** 产品应按地区提供儿童热线、危机热线和紧急服务，记录最后核验时间，无法确定地区时让学习者主动选择而不是偷偷获取精确位置。eSafety 要求按地区拆分外部支持服务并在风险识别、报告等需要时呈现；Child Helpline International 提供各地儿童热线目录，可作为候选目录但仍需逐地区核验。[eSafety 用户安全与报告机制指南](https://www.esafety.gov.au/industry/safety-by-design/foundations/empowering-users-to-stay-safe-online)；[Child Helpline International 全球目录](https://childhelplineinternational.org/helplines/)

## 建议的产品处置矩阵

以下矩阵是根据上述来源形成的**产品推导**，不是临床风险量表，也不能替代受训人员判断。

| 场景 | 可立即自动执行 | 必须人工判断 | 监护人策略 | 外部渠道 |
| --- | --- | --- | --- | --- |
| 一般低落、孤独或压力，没有自伤、虐待或现实威胁信号 | 简短共情；说明 AI 的能力边界；建议与自选可信成年人交谈；允许回到学习 | 通常不创建安全个案 | 不自动通知 | 提供可选的属地支持入口；非生命紧迫时鼓励持续专业支持。[WHO](https://www.emro.who.int/mhps/suicide.html) |
| 霸凌或网络霸凌，但没有即时人身危险 | 提供保存必要证据、屏蔽、举报和寻求学校/可信成年人帮助的选项；暂停同伴挑战中的相关互动 | 判断是否涉及威胁、跟踪、性内容或持续现实伤害；复核误报与被举报者处置 | 仅在确认是安全的非涉害监护人且通知有帮助时考虑 | 暴力威胁、跟踪或儿童性虐待材料等应按属地法律路由；美国官方指南把这些列为需向执法部门报告的情形，其他地区必须另行配置。[StopBullying.gov](https://www.stopbullying.gov/cyberbullying/how-to-report) |
| 自伤想法、虐待披露或“我不安全”，但紧迫性不明 | 停止普通学习生成；接纳披露；用一个清晰问题确认“你现在是否有立即危险”；展示其他可信成年人、儿童热线/危机热线 | 复核语境、紧迫性、适合的转介、是否需要依法报告；不得由模型判断真假或诊断 | 默认不通知；先确认监护人是否安全、是否涉害、学习者意愿及属地规则 | 由受训人员按属地协议转介；儿童与监护人应被告知报告要求并参与过程，但仅在“相关且适当”时纳入监护人。[Alliance CPHA 2024](https://alliancecpha.org/sites/default/files/technical/attachments/Inter-agency%20Child%20Protection%20Case%20Management%20Guidelines_2nd%20Edition_2024.pdf) |
| 明示危险正在发生、生命可能马上受威胁，或有人正在实施暴力 | 立即显示“去安全且有人在的地方、联系身边安全成年人、拨打当地紧急服务/危机热线”；普通对话保持暂停；高优先级内部告警 | 受训人员决定平台可否及如何对外披露、共享哪些最少信息，并记录依据；AI 不进行长问卷 | 若监护人可能涉害或通知可能增加风险，禁止通知该人；可考虑另一名已验证的安全成年人 | WHO 建议生命危险时寻求急诊/医院或紧急服务；若当事人拒绝但生命处于迫近危险，可能需要违背其意愿联系紧急服务。平台是否有权或有义务代为联系仍须属地法律确认。[WHO](https://www.emro.who.int/mhps/suicide.html) |
| 疑似儿童性虐待材料、引诱、明确犯罪或法定报告触发事项 | 隔离内容、不向其他学习者展示、不把内容用于生成或同伴挑战；告知将按安全流程处理 | 人工确认材料类别、保存边界、法定义务、接收机关与时限 | 不因账号绑定关系自动通知监护人；疑似涉害者不得收到通知 | 只能使用已为首发地区建立的法定渠道；eSafety 建议建立执法/专门热线协议，同时避免用不可操作或误报内容淹没这些渠道。[eSafety 非法及受限内容指南](https://www.esafety.gov.au/industry/safety-by-design/foundations/dealing-with-illegal-and-restricted-online-content) |

## 监护人通知决策

监护人通知不是二元的“开/关”设置，而是一项安全披露决定。建议人工审核界面强制逐项记录以下问题：

1. 当前是否存在迫近危险，延迟是否会明显增加伤害？
2. 拟通知者是否被披露为施害者、共谋者、控制者，或是学习者明确表示不信任的人？
3. 是否存在另一位已经验证的安全非涉害成年人，例如另一名监护人、亲属、教师、学校保护负责人或儿童热线？
4. 学习者是否已被用适龄语言告知拟共享的对象、最少内容、原因和下一步？其意见是什么？
5. 属地法律规定谁必须报告、什么事实触发、报告给谁、时限多久、必须共享哪些信息，平台及审核人员是否属于义务主体？
6. 通知或不通知分别可能造成哪些报复、隔离、污名、移除家庭、执法不当或其他二次伤害？

Alliance CPHA 的 2024 指南要求逐地区确认强制报告的案件范围、义务主体、触发门槛、接收机关、时限、共享字段、保密保障和报告后的风险，并指出执法能力、歧视及事件类型可能让强制报告本身对儿童和照护者产生风险。[Alliance CPHA 2024，第 113 页](https://alliancecpha.org/sites/default/files/technical/attachments/Inter-agency%20Child%20Protection%20Case%20Management%20Guidelines_2nd%20Edition_2024.pdf)

因此，本报告建议形成以下硬规则：

- **永不基于模型分数自动通知监护人。** 自动化只负责排队和即时安全文案；通知由受训人员审批。[eSafety Safety by Design 概览](https://www.esafety.gov.au/sites/default/files/2019-10/SBD%20-%20Overview%20May19.pdf?v=1720745795132)
- **被指涉或不安全的监护人永不成为默认接收人。** 这由“不得让儿童面对不信任者、不得把疑似施害者纳入会谈、优先非涉害照护者”推导而来。[UNICEF CCS 指南](https://www.unicef.org/media/155226/file/CCS%20Guidelines%20Final%20.pdf)
- **即使通知安全监护人，也只分享完成保护行动必需的信息。** 不默认转发完整对话、作业照片、同伴信息或 AI 推断。[Alliance CPHA 数据保护与信息共享协议](https://alliancecpha.org/sites/default/files/technical/attachments/Inter-agency%20Child%20Protection%20Case%20Management%20Data%20Protection%20and%20Information%20Sharing%20Protocol_English.pdf)
- **若法律要求在无同意情况下报告，仍应在不增加危险的前提下向学习者解释。** 例外共享须依严格程序、以儿童最大利益为首要考虑，并限于必要信息。[Alliance CPHA 数据保护与信息共享指导说明](https://alliancecpha.org/sites/default/files/technical/attachments/Guidance%20Note%20on%20Data%20Protection%20and%20Information%20Sharing%20in%20Child%20Protection%20Case%20Management.pdf)

## 不得完全自动化的判断与动作

| 不得完全自动化 | 原因与要求 |
| --- | --- |
| 判断披露真假、认定虐待、诊断自杀风险或精神状态 | AI 在危机级心理健康交互中可能产生危险、污名化或不恰当临床回应；Rhea 的 AI 导师不是治疗师。[UNICEF AI 指南 3.0](https://www.unicef.org/innocenti/media/11991/file/UNICEF-Innocenti-Guidance-on-AI-and-Children-3-2025.pdf) |
| 确定监护人是否安全、是否通知及通知内容 | 疑似施害者不得进入沟通，儿童不应被迫面对不信任的人；监护人监控也可能阻断求助。[UNICEF CCS 指南](https://www.unicef.org/media/155226/file/CCS%20Guidelines%20Final%20.pdf)；[联合国一般性意见第 25 号](https://docstore.ohchr.org/SelfServices/FilesHandler.ashx?enc=xfBzr2AVJ%2Fm%2FfXIEXW7hxTQrHodGBGQOLLAn9EXr%2BedAbHbjEePoBTI%2BN6n2B7SsntVQOGEX%2BbN2V0PM2w7hhQ%3D%3D) |
| 判定是否触发法定报告、报警、紧急服务或跨境披露 | 义务主体、门槛、接收机关、时限与保密要求均依当地法律和事件类型变化，且报告可能产生新的风险。[Alliance CPHA 2024](https://alliancecpha.org/sites/default/files/technical/attachments/Inter-agency%20Child%20Protection%20Case%20Management%20Guidelines_2nd%20Edition_2024.pdf) |
| 选择、封禁或长期标记被指控的学习伙伴 | 报告工具应有人在环、说明自动化并提供申诉；在事实未核实时只采取可逆的接触隔离和内容隐藏。[eSafety 用户安全与报告机制指南](https://www.esafety.gov.au/industry/safety-by-design/foundations/empowering-users-to-stay-safe-online) |
| 决定保存完整对话、图片、精确位置或身份多久 | 儿童数据应高隐私默认、最小收集和保留，通常不共享；敏感对话需严格目的限制与合法依据。[ICO 儿童守则](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/)；[UNICEF 企业建议（2026）](https://www.unicef.org/media/181136/file/UNICEF-When-AI-becomes-friend-Business-recommendations-2026.pdf) |

## 降低误报及二次伤害

- 将分类器输出命名为“安全信号”，在产品和数据库中避免“已自杀风险”“遭虐待者”等事实性标签；这遵循 UNICEF 对 AI 透明、可解释、问责和不贴临床结论的要求。[UNICEF AI 指南 3.0](https://www.unicef.org/innocenti/media/11991/file/UNICEF-Innocenti-Guidance-on-AI-and-Children-3-2025.pdf)
- 自动分流要结合第一人称、时态、否定、引用、课程材料与上下文，避免把科学课中的“受伤”、阅读材料中的暴力或对历史事件的讨论当成现实披露；无法消除的不确定性通过人工复核处理，而不是靠提高通知强度。eSafety 要求自动工具有人在环并持续评估社会与伦理预期。[eSafety Safety by Design 概览](https://www.esafety.gov.au/sites/default/files/2019-10/SBD%20-%20Overview%20May19.pdf?v=1720745795132)
- 安全提示本身应是低惩罚的：不扣 XP、不终止学习资格、不通知学习伙伴、不进入排行榜，不因一次误报永久封禁；对举报、内容隐藏、访问限制和账号操作提供儿童可理解的复核或申诉路径。[eSafety 用户安全与报告机制指南](https://www.esafety.gov.au/industry/safety-by-design/foundations/empowering-users-to-stay-safe-online)
- 对不同年龄、语言、方言、残障辅助方式及高风险表达测试漏报与误报，并把“近失事件”纳入发布后监测；UNICEF 企业建议要求记录模型版本、安全控制、事件、近失事件、缓解决定与已知风险。[UNICEF 企业建议（2026）](https://www.unicef.org/media/181136/file/UNICEF-When-AI-becomes-friend-Business-recommendations-2026.pdf)
- 不让学习者反复复述事件。人工审核应优先读取一次最小必要快照，并在需要更多信息时由受训人员提出少量开放式问题；儿童保护沟通规范明确反对审讯式、诱导式提问。[UNICEF CCS 指南](https://www.unicef.org/media/155226/file/CCS%20Guidelines%20Final%20.pdf)

## 敏感数据最小化基线

1. **分库分权。** 安全个案与学习档案、错题库、个性化和同伴挑战分离，使用假名化学习者 ID；只有被明确授权的安全审核角色按个案访问。儿童保护数据规范要求识别信息按 need-to-know、与目的相称的方式共享。[Alliance CPHA 数据保护与信息共享协议](https://alliancecpha.org/sites/default/files/technical/attachments/Inter-agency%20Child%20Protection%20Case%20Management%20Data%20Protection%20and%20Information%20Sharing%20Protocol_English.pdf)
2. **只留处置所需字段。** 建议默认记录安全信号类别、时间、最小原文片段或摘要、地区配置、自动展示的资源、人工决定及理由、共享对象与字段、状态和审计日志；除非属地协议证明必要，不复制整段聊天、作业图、联系人、精确位置或学习伙伴数据。联合国要求最小化和最少侵入，ICO 要求只收集和保留最少儿童数据。[联合国一般性意见第 25 号](https://docstore.ohchr.org/SelfServices/FilesHandler.ashx?enc=xfBzr2AVJ%2Fm%2FfXIEXW7hxTQrHodGBGQOLLAn9EXr%2BedAbHbjEePoBTI%2BN6n2B7SsntVQOGEX%2BbN2V0PM2w7hhQ%3D%3D)；[ICO 儿童守则](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/)
3. **严格目的限制。** 安全披露数据不得用于广告、模型训练、学习难度推断、掌握度、同伴推荐或竞技计分；任何二次使用都必须另有适用的合法依据。UNICEF 企业建议要求敏感对话数据严格目的限制，并在没有适用合法依据时禁止向第三方分享或二次使用。[UNICEF 企业建议（2026）](https://www.unicef.org/media/181136/file/UNICEF-When-AI-becomes-friend-Business-recommendations-2026.pdf)
4. **保留期限按目的和法律配置。** 每类记录都要有保留理由、最短期限、删除/法律保全规则及定期复核；不能因为“将来可能有用”无限保留。儿童数据最小化与敏感对话的紧缩保留要求来自 ICO 与 UNICEF。[ICO 儿童守则](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/)；[UNICEF 企业建议（2026）](https://www.unicef.org/media/181136/file/UNICEF-When-AI-becomes-friend-Business-recommendations-2026.pdf)
5. **儿童可理解的透明度。** 在收集、人工查看或向外共享前，说明谁会看到、为什么、可能发生什么、能否更正或申诉；联合国要求儿童友好的报告和补救机制，eSafety 要求说明自动安全工具及报告处理时限和结果。[联合国一般性意见第 25 号](https://docstore.ohchr.org/SelfServices/FilesHandler.ashx?enc=xfBzr2AVJ%2Fm%2FfXIEXW7hxTQrHodGBGQOLLAn9EXr%2BedAbHbjEePoBTI%2BN6n2B7SsntVQOGEX%2BbN2V0PM2w7hhQ%3D%3D)；[eSafety 用户安全与报告机制指南](https://www.esafety.gov.au/industry/safety-by-design/foundations/empowering-users-to-stay-safe-online)

## 必须等首发司法辖区确定后再决策

下列配置不能用“全球默认值”替代法律与运营核验。Alliance CPHA 明确要求在本地逐项评估强制报告范围、义务主体、触发条件、接收机关、时限、共享内容、保密和报告后果。[Alliance CPHA 2024，第 113 页](https://alliancecpha.org/sites/default/files/technical/attachments/Inter-agency%20Child%20Protection%20Case%20Management%20Guidelines_2nd%20Edition_2024.pdf)

- 平台、承包商、学校、教师或特定岗位是否属于强制报告义务主体；“怀疑”“合理理由”“实际知悉”各自的触发门槛。
- 自伤/自杀风险、身体或性虐待、忽视、霸凌、暴力威胁、引诱和儿童性虐待材料各自应向谁报告，以及是否存在法定时限、保存义务或禁止通知涉害者的要求。
- 在没有儿童或监护人同意时处理、查看和披露敏感数据的合法依据；监护人同意与儿童自身隐私、访问、更正、删除和申诉权之间的年龄门槛。
- 紧急服务是否接受平台代报、需要哪些位置/身份信息、平台能否可靠确认学习者所在地，以及跨境数据传输与执法请求流程。
- 属地儿童热线、危机热线、学校保护渠道和紧急号码；支持语言、服务时间、可服务年龄、文本/电话可达性与最后核验周期。eSafety 要求按地区提供支持渠道。[eSafety 用户安全与报告机制指南](https://www.esafety.gov.au/industry/safety-by-design/foundations/empowering-users-to-stay-safe-online)
- 安全记录的法定保留期、删除例外、法律保全、数据泄露通知、审核人员背景审查和是否需要本地持证专业人员。
- 对自动检测、人工复核、监护人通知和外部报告的透明告知、申诉和监管报告要求。欧盟委员会的未成年人保护指南采用风险、隐私与安全设计方法，并要求改善报告工具和及时反馈，但其适用与合规结论仍需按服务范围判断。[欧盟委员会 DSA 未成年人保护指南说明](https://digital-strategy.ec.europa.eu/en/library/commission-publishes-guidelines-protection-minors)

## 上线门槛与验收条件

以下是研究结论转化出的建议验收条件：

- AI 导师在首次使用及安全升级时明确说明自己是 AI、不是人类朋友或治疗师，不承诺实时监控或保密。[UNICEF AI 指南 3.0](https://www.unicef.org/innocenti/media/11991/file/UNICEF-Innocenti-Guidance-on-AI-and-Children-3-2025.pdf)
- 每个首发地区有经法律与儿童保护负责人批准的事件分类、人工 SLA、监护人安全判断、法定报告矩阵、最小共享字段和资源目录；资源带有负责人和 `last_verified_at`。[Alliance CPHA 2024](https://alliancecpha.org/sites/default/files/technical/attachments/Inter-agency%20Child%20Protection%20Case%20Management%20Guidelines_2nd%20Edition_2024.pdf)；[eSafety](https://www.esafety.gov.au/industry/safety-by-design/foundations/empowering-users-to-stay-safe-online)
- 有受训的人工安全审核角色；模型不能直接发消息给监护人或外部机构，所有外部披露都记录人工批准者、法律/政策依据、共享字段与时间。[eSafety Safety by Design 概览](https://www.esafety.gov.au/sites/default/files/2019-10/SBD%20-%20Overview%20May19.pdf?v=1720745795132)
- “监护人可能涉害/学习者不信任监护人”测试必然阻止自动通知，并给出其他可信成年人、儿童热线和属地紧急路径。[UNICEF CCS 指南](https://www.unicef.org/media/155226/file/CCS%20Guidelines%20Final%20.pdf)
- 所有安全动作不影响 XP、掌握度、排行榜或挑战成绩；误报可以安全返回学习，限制性措施具有适龄解释和申诉入口。[eSafety 用户安全与报告机制指南](https://www.esafety.gov.au/industry/safety-by-design/foundations/empowering-users-to-stay-safe-online)
- 安全数据与学习数据隔离，访问按个案授权，默认不训练模型、不做画像、不向学习伙伴展示；保留与删除策略通过 DPIA/儿童权利影响评估。[ICO 儿童守则](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/)；[联合国一般性意见第 25 号](https://docstore.ohchr.org/SelfServices/FilesHandler.ashx?enc=xfBzr2AVJ%2Fm%2FfXIEXW7hxTQrHodGBGQOLLAn9EXr%2BedAbHbjEePoBTI%2BN6n2B7SsntVQOGEX%2BbN2V0PM2w7hhQ%3D%3D)
- 上线前以各支持语言覆盖直接表达、隐喻、否定、引用、教材内容和恶意诱导，分别验证漏报、误报、路由正确率及响应时延；上线后记录事件和近失事件并定期复审。[UNICEF 企业建议（2026）](https://www.unicef.org/media/181136/file/UNICEF-When-AI-becomes-friend-Business-recommendations-2026.pdf)

## 对 Rhea 既有决策的影响

此前“平台人员默认不能查看儿童作业”的边界可以保留，但要增加一个严格隔离的安全例外：只有安全信号进入人工复核后，被授权的安全审核人员才能按个案查看最小必要片段；这不是普通学习内容审核权限。若产品不准备建立这种受训人工能力，就只能提供透明的自助转介，不能承诺完成监护人通知、法定报告或紧急救援。该结论是从 need-to-know、人工在环和危机协议要求推导出的产品边界。[Alliance CPHA 数据保护与信息共享协议](https://alliancecpha.org/sites/default/files/technical/attachments/Inter-agency%20Child%20Protection%20Case%20Management%20Data%20Protection%20and%20Information%20Sharing%20Protocol_English.pdf)；[eSafety Safety by Design](https://www.esafety.gov.au/industry/safety-by-design)；[UNICEF 企业建议（2026）](https://www.unicef.org/media/181136/file/UNICEF-When-AI-becomes-friend-Business-recommendations-2026.pdf)

建议新增后续产品决策：选择首发司法辖区后，由儿童保护、当地法律、隐私和运营负责人共同完成“安全升级属地包”，再确定 Rhea 是否提供人工监控与对外升级；在此之前，产品方案应把任何自动通知监护人的能力明确列为禁止项。

## 一手来源清单

- [联合国儿童权利委员会：《关于儿童在数字环境中的权利的一般性意见第 25 号》（2021）](https://docstore.ohchr.org/SelfServices/FilesHandler.ashx?enc=xfBzr2AVJ%2Fm%2FfXIEXW7hxTQrHodGBGQOLLAn9EXr%2BedAbHbjEePoBTI%2BN6n2B7SsntVQOGEX%2BbN2V0PM2w7hhQ%3D%3D)
- [UNICEF：《Guidance on AI and Children 3.0》（2025）](https://www.unicef.org/innocenti/media/11991/file/UNICEF-Innocenti-Guidance-on-AI-and-Children-3-2025.pdf)
- [UNICEF：《When AI becomes a friend — Business recommendations》（2026）](https://www.unicef.org/media/181136/file/UNICEF-When-AI-becomes-friend-Business-recommendations-2026.pdf)
- [UNICEF：《CCS Guidelines》（儿童性虐待幸存者个案管理沟通规范）](https://www.unicef.org/media/155226/file/CCS%20Guidelines%20Final%20.pdf)
- [Alliance for Child Protection in Humanitarian Action：《Inter-agency Guidelines for Case Management and Child Protection》，第二版（2024）](https://alliancecpha.org/sites/default/files/technical/attachments/Inter-agency%20Child%20Protection%20Case%20Management%20Guidelines_2nd%20Edition_2024.pdf)
- [Alliance CPHA：儿童保护个案数据保护与信息共享协议](https://alliancecpha.org/sites/default/files/technical/attachments/Inter-agency%20Child%20Protection%20Case%20Management%20Data%20Protection%20and%20Information%20Sharing%20Protocol_English.pdf)
- [WHO：Mental health and psychosocial support platform — suicide](https://www.emro.who.int/mhps/suicide.html)
- [英国 Information Commissioner’s Office：Age appropriate design code](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/age-appropriate-design-a-code-of-practice-for-online-services/)
- [澳大利亚 eSafety Commissioner：Safety by Design](https://www.esafety.gov.au/industry/safety-by-design)
- [欧盟委员会：DSA 未成年人保护指南说明（2025）](https://digital-strategy.ec.europa.eu/en/library/commission-publishes-guidelines-protection-minors)
- [美国 StopBullying.gov：Report Cyberbullying](https://www.stopbullying.gov/cyberbullying/how-to-report)
- [Child Helpline International：全球儿童热线目录](https://childhelplineinternational.org/helplines/)
