//! Bounded lexical recall, not a claim that the model chose a suitable action.
//! Publisher prose can help retrieval; it cannot grant identity or authorization.
use std::collections::BTreeSet;

use super::types::Candidate;

const CURRENT: &str = "Current user message:\n";

pub fn recall(context: &str, candidates: &[Candidate]) -> Vec<Candidate> {
    let query = normalize(current(context));
    if !task_intent(&query) {
        return clarification_context(context, candidates)
            .map(|resolved| {
                rank(&resolved, candidates)
                    .into_iter()
                    .take(12)
                    .map(|(_, candidate)| candidate.clone())
                    .collect()
            })
            .unwrap_or_default();
    }
    let mut ranked = rank(&query, candidates);
    // Only short explicit continuations may borrow context. A new topic, thanks
    // or greeting never revives a tool suggestion from an earlier conversation.
    if ranked.is_empty()
        && follow_up(&query)
        && let Some((previous, _)) = context.rsplit_once(CURRENT)
    {
        ranked = rank(&normalize(previous), candidates);
    }
    if ranked.is_empty()
        && let Some(resolved) = clarification_context(context, candidates)
    {
        ranked = rank(&resolved, candidates);
    }
    ranked
        .into_iter()
        .take(12)
        .map(|(_, candidate)| candidate.clone())
        .collect()
}

/// A compact answer to an explicit clarification may be a company, place, date
/// or period rather than a new command. Only the server's ordinary user turns
/// establish the underlying task; assistant prose cannot introduce a new one.
fn clarification_context(context: &str, candidates: &[Candidate]) -> Option<String> {
    let (previous, raw_query) = context.rsplit_once(CURRENT)?;
    let query = normalize(raw_query);
    if !slot_answer(raw_query, &query) {
        return None;
    }
    let recent = previous.strip_prefix("Recent conversation:\n")?.trim();
    let messages: Vec<serde_json::Value> = serde_json::from_str(recent).ok()?;
    let last = messages.last()?;
    if last["role"] != "assistant" {
        return None;
    }
    let clarification = normalize(last["content"].as_str()?);
    if !any(
        &clarification,
        &[
            "哪家",
            "哪只",
            "哪个",
            "哪些",
            "什么时间",
            "什么日期",
            "请提供",
            "请告诉",
            "which",
            "what period",
            "what date",
            "what city",
            "what company",
            "where",
            "when",
            "please provide",
            "please specify",
        ],
    ) {
        return None;
    }
    for message in messages
        .iter()
        .rev()
        .filter(|message| message["role"] == "user")
        .take(2)
    {
        let raw_prompt = message["content"].as_str()?;
        let prompt = normalize(raw_prompt);
        if task_intent(&prompt) && !rank(&prompt, candidates).is_empty() {
            return Some(format!("{prompt} {query}"));
        }
        // A second short parameter can continue the earlier request, but an
        // unrelated intervening task must not resurrect an older capability.
        if !slot_answer(raw_prompt, &prompt) {
            return None;
        }
    }
    None
}

fn slot_answer(raw: &str, query: &str) -> bool {
    if query.is_empty()
        || query.chars().count() > 64
        || raw.contains(['?', '？'])
        || query.split_whitespace().count() > 8
        || content_work(query)
        || any(
            query,
            &[
                "谢谢",
                "感谢",
                "你好",
                "晚安",
                "早上好",
                "不用",
                "算了",
                "取消",
                "换话题",
                "不需要",
                "别查",
                "心情",
                "天气很好",
                "我觉得",
                "我今天",
                "我喜欢",
                "我想",
                "没有",
                "再见",
                "不了",
                "等会",
                "等一下",
                "不知道",
                "好的",
                "好吧",
                "嗯嗯",
                "可以",
                "随便",
                "聊聊",
                "thanks",
                "thank you",
                "hello",
                "good night",
                "never mind",
                "cancel",
                "stop",
                "not now",
                "maybe later",
                "no thanks",
                "i feel",
                "i think",
                "i want",
                "can you",
                "could you",
                "by the way",
                "instead",
                "okay",
                "fine",
                "sure",
                "ok",
                "yes",
                "no",
                "alright",
                "talk",
                "chat",
                "no plugins",
                "do not",
                "don't",
            ],
        )
    {
        return false;
    }
    // Reject new instructions and full conversational sentences. Single labels
    // and short comma-separated parameters remain domain/provider independent.
    !any(
        query,
        &[
            "帮我",
            "帮忙",
            "请给",
            "打开",
            "进入",
            "连接",
            "推荐",
            "不要",
            "查询",
            "查一下",
            "查查",
            "show",
            "check",
            "find",
            "search",
            "open",
            "connect",
            "recommend",
            "please",
            "need",
            "want",
            "什么",
            "为什么",
            "怎么",
            "如何",
            "what",
            "why",
            "how",
            "who",
            "where",
            "when",
            "which",
        ],
    )
}

pub fn exact(context: &str, candidates: &[Candidate]) -> Vec<Candidate> {
    let query = normalize(current(context));
    if !task_intent(&query) {
        return Vec::new();
    }
    // Personal names require an explicit action and a unique catalog match.
    // Names select stable candidate IDs; they never grant runtime authority.
    rank(&query, candidates)
        .into_iter()
        .filter(|(_, candidate)| {
            explicit_use(&query, candidate)
                && (candidate.trusted || explicit_personal(&query, candidate, candidates))
        })
        .take(3)
        .map(|(_, candidate)| candidate.clone())
        .collect()
}

fn explicit_personal(query: &str, candidate: &Candidate, candidates: &[Candidate]) -> bool {
    candidate.exact_names.iter().any(|name| {
        let normalized = normalize(name);
        ![
            "插件",
            "服务",
            "助手",
            "查询",
            "工具",
            "plugin",
            "service",
            "assistant",
            "tools",
            "search",
            "data",
            "it",
            "the",
        ]
        .contains(&normalized.as_str())
            && phrase(query, name)
            && candidates
                .iter()
                .filter(|other| {
                    other
                        .exact_names
                        .iter()
                        .any(|alias| normalize(alias) == normalized)
                })
                .count()
                == 1
    })
}

fn explicit_use(query: &str, candidate: &Candidate) -> bool {
    const ACTIONS: &[&str] = &[
        "打开",
        "进入",
        "使用",
        "连接",
        "切换到",
        "查看",
        "open",
        "use",
        "launch",
        "connect",
        "switch to",
        "view",
    ];
    const CONNECTORS: &[&str] = &[
        "",
        "the",
        "my",
        "our",
        "a",
        "plugin",
        "service",
        "my connected",
        "my personal",
        "the connected",
        "我的",
        "我连接的",
        "已连接的",
        "已添加的",
        "这个",
        "那个",
        "插件",
        "模块",
    ];
    candidate.exact_names.iter().any(|name| {
        let name = normalize(name);
        !name.is_empty()
            && phrase(query, &name)
            && query.match_indices(&name).any(|(start, _)| {
                let before = query[..start].trim_end();
                ACTIONS.iter().any(|action| {
                    before.rfind(action).is_some_and(|index| {
                        let action_is_word = !action.is_ascii()
                            || index == 0
                            || !before[..index]
                                .chars()
                                .next_back()
                                .is_some_and(|c| c.is_ascii_alphanumeric());
                        action_is_word
                            && CONNECTORS.contains(&before[index + action.len()..].trim())
                    })
                })
            })
    })
}

fn content_work(query: &str) -> bool {
    any(
        query,
        &[
            "写一首",
            "写一个",
            "写一段",
            "写个",
            "写封",
            "文案",
            "诗歌",
            "故事",
            "剧本",
            "翻译",
            "write",
            "draft",
            "compose",
            "translate",
            "rewrite",
            "proofread",
            "summarize",
        ],
    )
}

fn current(context: &str) -> &str {
    context
        .rsplit_once(CURRENT)
        .map_or(context, |(_, query)| query)
}

fn normalize(value: &str) -> String {
    value
        .chars()
        .take(16_000)
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn phrase(query: &str, term: &str) -> bool {
    let term = normalize(term);
    if term.chars().count() < 2 {
        return false;
    }
    query.match_indices(&term).any(|(start, matched)| {
        let end = start + matched.len();
        let first_ascii = term
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric());
        let last_ascii = term
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric());
        (!first_ascii
            || !query[..start]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric()))
            && (!last_ascii
                || !query[end..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric()))
    })
}

fn any(query: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| phrase(query, term))
}

fn task_intent(query: &str) -> bool {
    if any(
        query,
        &[
            "不要推荐",
            "别推荐",
            "不用插件",
            "不使用插件",
            "无需插件",
            "不想用插件",
            "don't recommend",
            "do not recommend",
            "no plugins",
            "without plugins",
            "don't use tools",
            "do not use tools",
        ],
    ) {
        return false;
    }
    let live = any(
        query,
        &[
            "实时",
            "最新",
            "今天",
            "现在",
            "查询",
            "查一下",
            "打开",
            "进入",
            "current",
            "latest",
            "today",
            "right now",
            "look up",
            "open",
            "connect",
        ],
    );
    if !live
        && any(
            query,
            &[
                "什么是",
                "是什么意思",
                "解释",
                "科普",
                "原理",
                "什么区别",
                "翻译",
                "用英语怎么说",
                "what is",
                "what are",
                "explain",
                "definition",
                "meaning of",
                "why",
                "how does",
                "difference between",
            ],
        )
    {
        return false;
    }
    any(
        query,
        &[
            "查询",
            "查一下",
            "查查",
            "查一查",
            "查下",
            "查看",
            "搜索",
            "搜一下",
            "找",
            "打开",
            "进入",
            "切换",
            "管理",
            "添加",
            "连接",
            "接入",
            "授权",
            "帮我",
            "帮忙",
            "请给",
            "请查",
            "我想",
            "想要",
            "需要",
            "我要",
            "能否",
            "看看",
            "看下",
            "实时",
            "最新",
            "今天",
            "现在",
            "多少",
            "比较",
            "对比",
            "生成",
            "制作",
            "设置",
            "show",
            "check",
            "find",
            "look up",
            "lookup",
            "search",
            "open",
            "launch",
            "connect",
            "authorize",
            "add",
            "create",
            "generate",
            "make",
            "send",
            "compare",
            "manage",
            "switch",
            "update",
            "view",
            "want",
            "need",
            "please",
            "can you",
            "could you",
            "today",
            "current",
            "latest",
            "price",
            "balance",
            "browse",
            "track",
            "resume",
            "continue",
        ],
    )
}

fn follow_up(query: &str) -> bool {
    query.chars().count() <= 48
        && any(
            query,
            &[
                "这个", "那个", "它", "继续", "that one", "this one", "it", "continue",
            ],
        )
}

fn named(query: &str, candidate: &Candidate) -> bool {
    candidate.exact_names.iter().any(|name| phrase(query, name))
}

fn bank_relevant(query: &str, candidate: &Candidate) -> bool {
    if candidate.bank_id.is_none() {
        return true;
    }
    if !named(query, candidate) {
        return false;
    }
    if any(
        query,
        &[
            "真实",
            "实际银行",
            "real money",
            "real bank",
            "live account",
        ],
    ) {
        return false;
    }
    candidate.access == "ready"
        || any(
            query,
            &[
                "模拟",
                "演示",
                "插件",
                "demo",
                "simulated",
                "simulation",
                "plugin",
            ],
        )
}

fn rank<'a>(query: &str, candidates: &'a [Candidate]) -> Vec<(u32, &'a Candidate)> {
    let tokens = tokens(query);
    let named_plugin = candidates.iter().any(|candidate| {
        candidate.kind == "plugin"
            && candidate.access != "unavailable"
            && bank_relevant(query, candidate)
            && named(query, candidate)
    });
    let mut ranked: Vec<_> = candidates
        .iter()
        .filter_map(|candidate| {
            if candidate.access == "unavailable"
                || !bank_relevant(query, candidate)
                || (candidate.module.as_deref() == Some("plugins") && named_plugin)
                || (candidate.trusted && content_work(query) && !explicit_use(query, candidate))
            {
                return None;
            }
            let explicit = named(query, candidate);
            let mut score = if explicit {
                if candidate.kind == "plugin" { 140 } else { 80 }
            } else {
                0
            };
            for term in &candidate.search_terms {
                if phrase(query, term) {
                    score += if term.chars().count() >= 4 { 14 } else { 9 };
                }
            }
            // Dynamic capabilities need no provider/name allow-list. Independent
            // content words and CJK bigrams recall unfamiliar services from accepted
            // snapshots. Generic verbs/boilerplate are omitted to avoid chat matches.
            if !candidate.trusted {
                let metadata = candidate.search_terms.join(" ");
                let terms = self::tokens(&normalize(&metadata));
                let overlap = tokens.intersection(&terms).count().min(8) as u32;
                score += overlap * 5;
            }
            (score >= 5).then_some((score, candidate))
        })
        .collect();
    ranked.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| readiness(&left.access).cmp(&readiness(&right.access)))
            .then_with(|| left.id.cmp(&right.id))
    });
    ranked
}

fn readiness(access: &str) -> u8 {
    match access {
        "ready" => 0,
        "connect" => 1,
        "authorize" => 2,
        "review" => 3,
        _ => 4,
    }
}

fn tokens(value: &str) -> BTreeSet<String> {
    const STOP: &[&str] = &[
        "the",
        "and",
        "for",
        "with",
        "this",
        "that",
        "your",
        "from",
        "have",
        "you",
        "are",
        "can",
        "could",
        "would",
        "please",
        "want",
        "need",
        "find",
        "search",
        "show",
        "check",
        "open",
        "use",
        "using",
        "get",
        "look",
        "data",
        "information",
        "query",
        "request",
        "service",
        "tool",
        "tools",
        "plugin",
        "plugins",
        "current",
        "latest",
        "today",
        "now",
        "我的",
        "一下",
        "帮我",
        "帮忙",
        "请问",
        "查询",
        "查看",
        "搜索",
        "需要",
        "想要",
        "现在",
        "今天",
        "最新",
        "实时",
        "服务",
        "工具",
        "插件",
        "数据",
        "信息",
        "可以",
        "提供",
        "使用",
        "相关",
        "用户",
        "任务",
        "进行",
        "以及",
        "通过",
        "获取",
    ];
    let mut result = BTreeSet::new();
    for word in value.split_whitespace() {
        let mut ascii = String::new();
        let mut cjk = Vec::new();
        for character in word.chars().chain(std::iter::once(' ')) {
            if character.is_ascii_alphanumeric() {
                ascii.push(character);
                cjk.clear();
            } else {
                if ascii.len() >= 3 && !STOP.contains(&ascii.as_str()) {
                    result.insert(ascii.clone());
                }
                ascii.clear();
                if ('\u{3400}'..='\u{9fff}').contains(&character) {
                    cjk.push(character);
                    if cjk.len() >= 2 {
                        let token: String = cjk[cjk.len() - 2..].iter().collect();
                        if !STOP.contains(&token.as_str()) {
                            result.insert(token);
                        }
                    }
                } else {
                    cjk.clear();
                }
            }
        }
    }
    result
}
