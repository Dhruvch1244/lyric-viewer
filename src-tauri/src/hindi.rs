//! Offline romanized-Hindi → Devanagari transliteration (script, not meaning).
//!
//! WHY NOT THE LLM ANY MORE. `transliterate.rs` used to send the whole lyric
//! sheet to `llm::convert`, and that failed two ways for real:
//!   - Hosted models refuse it. Reproducing 35+ lines of a song's lyrics is
//!     exactly what their copyright policy forbids, so every provider came back
//!     with a refusal and the user saw "all providers failed".
//!   - It ran inside a sync `#[tauri::command]`, i.e. on Tauri's main thread,
//!     so the whole window froze for the length of the network round trip.
//!
//! Changing the writing system of text the user already has needs no model
//! that can refuse, so this is done locally, deterministically, in three tiers:
//!
//!   1. `CORE` — a hand-written table of the few hundred words that make up
//!      most of any Hindi/Punjabi lyric (pronouns, postpositions, auxiliaries,
//!      the love-song vocabulary). These are exactly the words a mechanical
//!      spelling gets wrong (`main` → मैं, not मैन; `kyun` → क्यों) and, as
//!      measured, exactly the words the downloadable lexicon does NOT have:
//!      Aksharantar drops short high-frequency words, so `tum`, `dil`, `kya`,
//!      `nahi`, `hai` are missing or noisy in it.
//!   2. The **Hindi pack** — an optional download (Aksharantar, AI4Bharat;
//!      CC0/CC-BY), turned on this machine into a one-word-per-line lexicon
//!      of ~1M romanized spellings. Long-tail coverage: names, rarer words.
//!   3. `rules` — a greedy longest-match romanization reader, for anything
//!      neither table knows. Always available, so the अ button works on a
//!      fresh install with no download and no API key.
//!
//! English stays English: a line that is mostly English words is left in
//! Latin, and known English words inside a Hindi line are kept as they are.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::lyrics::Cue;

// ------------------------------------------------------------------ rules

/// Consonant spellings, longest first so `chh` wins over `ch` over `c`.
const CONSONANTS: &[(&str, &str)] = &[
    ("cchh", "च्छ"),
    ("chh", "छ"),
    ("cch", "च्छ"),
    ("ksh", "क्ष"),
    ("ck", "क"),
    ("kh", "ख"),
    ("gh", "घ"),
    ("ch", "च"),
    ("jh", "झ"),
    ("th", "थ"),
    ("dh", "ध"),
    ("ph", "फ"),
    ("bh", "भ"),
    ("sh", "श"),
    ("k", "क"),
    ("g", "ग"),
    ("c", "क"),
    ("j", "ज"),
    ("t", "त"),
    ("d", "द"),
    ("n", "न"),
    ("p", "प"),
    ("b", "ब"),
    ("m", "म"),
    ("y", "य"),
    ("r", "र"),
    ("l", "ल"),
    ("v", "व"),
    ("w", "व"),
    ("s", "स"),
    ("h", "ह"),
    ("z", "ज़"),
    ("f", "फ़"),
    ("q", "क़"),
    ("x", "क्स"),
];

/// (roman, independent form, matra). `a` has no matra: it is the consonant's
/// inherent vowel.
const VOWELS: &[(&str, &str, &str)] = &[
    ("aa", "आ", "ा"),
    ("ai", "ऐ", "ै"),
    ("au", "औ", "ौ"),
    ("ee", "ई", "ी"),
    ("ii", "ई", "ी"),
    ("oo", "ऊ", "ू"),
    ("uu", "ऊ", "ू"),
    ("a", "अ", ""),
    ("i", "इ", "ि"),
    ("u", "उ", "ु"),
    ("e", "ए", "े"),
    ("o", "ओ", "ो"),
];

const VIRAMA: &str = "्";
const ANUSVARA: &str = "ं";

fn match_at<'a, T>(word: &str, pos: usize, table: &'a [T], key: impl Fn(&T) -> &str) -> Option<&'a T> {
    let rest = &word[pos..];
    table.iter().find(|e| rest.starts_with(key(e)))
}

/// Whether a word-internal consonant pair is written as a conjunct.
fn joined(c1: &str, c2: &str) -> bool {
    static SET: std::sync::OnceLock<HashSet<(&'static str, &'static str)>> = std::sync::OnceLock::new();
    let separate = SET.get_or_init(|| {
        SEPARATE.split_whitespace().filter_map(|p| p.split_once('+')).collect()
    });
    // A doubled consonant is a conjunct in Hindi (दिल्ली, पत्ता, बच्चा). The
    // learner says otherwise for a few (`l+l`), outvoted by English loanwords
    // whose double letters are one sound (football → फुटबॉल).
    c1 == c2 || !separate.contains(&(c1, c2))
}

/// Word-internal consonant pairs Hindi spells as two full letters (अपना,
/// बचपन, बरसात) rather than as a conjunct (मस्ती, दोस्त), `c1+c2` by
/// romanization. Learned, not hand-picked: `learn_joins` below flips each
/// cluster of every Aksharantar training word both ways and keeps the pairs
/// where "separate" matched the real spelling more often (at least 30 votes).
/// Before this table every cluster was a conjunct, which is wrong far more
/// often than right: 515 pairs came out "separate".
const SEPARATE: &str = concat!(
    "b+c b+ch b+f b+g b+gh b+k b+kh b+l b+m b+n b+p b+s b+sh b+t b+v b+w b+y bh+d bh+g bh+j bh+k ",
    "bh+m bh+n bh+p bh+s c+b c+c c+d c+m c+n c+q c+y ch+b ch+bh ch+c ch+d ch+f ch+g ch+j ch+k ",
    "ch+kh ch+l ch+m ch+n ch+p ch+r ch+s ch+sh ch+t ch+v ch+w chh+p chh+t chh+v chh+w ck+b ck+ch ",
    "ck+d ck+f ck+g ck+h ck+l ck+m ck+n ck+p ck+sh ck+t ck+w ck+y d+b d+bh d+c d+ch d+f d+g d+j ",
    "d+k d+kh d+l d+m d+n d+p d+ph d+q d+s d+sh d+t d+th d+v d+w d+z dh+b dh+bh dh+ch dh+g dh+j ",
    "dh+k dh+l dh+m dh+n dh+p dh+r dh+s dh+sh dh+t dh+v dh+w f+b f+c f+ch f+d f+f f+g f+gh f+h ",
    "f+j f+k f+kh f+l f+m f+n f+p f+r f+s f+sh f+t f+v f+w f+y f+z g+b g+bh g+c g+ch g+chh g+d ",
    "g+f g+g g+j g+jh g+k g+kh g+l g+m g+p g+q g+s g+sh g+t g+th g+v g+w g+z gh+b gh+ch gh+d gh+j ",
    "gh+k gh+l gh+m gh+p gh+r gh+s gh+t gh+v gh+w h+b h+bh h+ch h+d h+dh h+f h+g h+h h+j h+k h+kh ",
    "h+l h+m h+n h+p h+r h+s h+sh h+t h+th h+v h+w h+y h+z j+b j+bh j+ch j+d j+dh j+g j+gh j+k ",
    "j+kh j+l j+m j+n j+p j+r j+s j+sh j+t j+v j+w jh+g jh+k jh+t k+b k+bh k+ch k+d k+dh k+f k+g ",
    "k+gh k+j k+jh k+l k+m k+n k+p k+r k+s k+v k+w k+z kh+b kh+bh kh+ch kh+d kh+dh kh+g kh+j kh+k ",
    "kh+l kh+m kh+n kh+p kh+r kh+s kh+v kh+w ksh+b ksh+n ksh+p ksh+t ksh+v l+b l+bh l+c l+ch ",
    "l+chh l+dh l+g l+gh l+j l+jh l+k l+kh l+l l+m l+n l+p l+q l+r l+s l+sh l+v l+w l+z m+b m+bh ",
    "m+c m+ch m+d m+dh m+f m+g m+gh m+j m+jh m+k m+kh m+l m+n m+p m+r m+s m+sh m+t m+th m+v m+w ",
    "m+y m+z n+b n+c n+ch n+d n+f n+g n+h n+j n+k n+l n+m n+p n+r n+s n+sh n+t n+v n+w p+b p+bh ",
    "p+c p+ch p+d p+dh p+f p+g p+gh p+j p+k p+kh p+m p+n p+sh p+th p+v p+w p+y ph+s ph+y q+b r+b ",
    "r+c r+ch r+chh r+f r+gh r+h r+jh r+k r+kh r+l r+p r+q r+r r+w s+b s+bh s+ch s+d s+dh s+f s+g ",
    "s+gh s+j s+kh s+l s+n s+r s+s s+sh s+v s+z sh+b sh+bh sh+c sh+d sh+dh sh+f sh+g sh+h sh+j ",
    "sh+kh sh+m sh+s sh+sh t+b t+bh t+c t+ch t+d t+dh t+f t+g t+gh t+j t+k t+kh t+l t+n t+p t+ph ",
    "t+sh t+w th+b th+bh th+c th+ch th+d th+dh th+f th+g th+h th+j th+k th+kh th+l th+m th+n th+p ",
    "th+r th+s th+sh th+t th+v th+w v+b v+bh v+c v+ch v+d v+dh v+g v+gh v+h v+j v+k v+kh v+l v+m ",
    "v+n v+p v+r v+s v+sh v+t v+th v+w w+b w+d w+k w+l w+m w+n w+r w+s w+t w+y x+b x+c x+ch x+f ",
    "x+g x+h x+k x+l x+m x+p x+s x+t x+v x+w x+y y+b y+bh y+c y+ch y+d y+dh y+f y+g y+gh y+h y+j ",
    "y+k y+kh y+l y+m y+n y+p y+ph y+r y+s y+sh y+t y+th y+v y+w y+z z+b z+c z+d z+g z+h z+k z+l ",
    "z+m z+n z+p z+r z+s z+t z+v z+w z+y z+z ",
);

/// Does `stem` end in a consonant letter (so a following vowel is a matra)?
fn after_consonant_end(stem: &str) -> bool {
    stem.as_bytes().last().is_some_and(|b| !matches!(b, b'a' | b'e' | b'i' | b'o' | b'u'))
}

fn is_vowel_start(word: &str, pos: usize) -> bool {
    match_at(word, pos, VOWELS, |v| v.0).is_some()
}

/// Read one lowercase ASCII romanized word as Hindi.
///
/// Conventions it encodes, all from how Hindi is actually typed in lyric
/// sheets: a word-final `a`/`i`/`u` after a consonant is long (`mera` →
/// मेरा, `zindagi` → ज़िंदगी, `aansu` → आँसू-ish); `n` between a vowel and a
/// consonant is the nasal anusvara (`zindagi`, `andar`); adjacent consonants
/// form a conjunct; and a word-final consonant keeps no explicit virama
/// (Hindi drops the final schwa in speech, not in writing).
pub(crate) fn rules(word: &str) -> String {
    rules_with(word, &mut |_, c1, c2| joined(c1, c2))
}

/// `rules`, with the one judgement call it makes left to `join`: whether a
/// consonant pair inside a word is written as a conjunct (मस्ती, दोस्त) or as
/// two full letters with the vowel left silent (अपना, बचपन). `join` gets the
/// cluster's index in the word and both romanizations. Split out so the pair
/// table can be learned against real spellings (see `learn_joins`).
fn rules_with(word: &str, join: &mut dyn FnMut(usize, &str, &str) -> bool) -> String {
    // Nasal plural/oblique endings, the commonest spelling the letter-by-letter
    // reading gets wrong: `aankhon` → आँखों, `baaten`/`baatein` → बातें.
    for (ending, vowel, nasal) in [("ein", "e", "ें"), ("on", "o", "ों"), ("en", "e", "ें")] {
        if word.len() > ending.len() + 1 && word.ends_with(ending) {
            let stem = &word[..word.len() - ending.len()];
            let mut out = rules_with(&format!("{stem}{vowel}"), join);
            // The stem reading ended in the plain vowel; swap it for the nasal one.
            let plain = if after_consonant_end(stem) { if vowel == "o" { "ो" } else { "े" } } else { "" };
            if !plain.is_empty() && out.ends_with(plain) {
                out.truncate(out.len() - plain.len());
                out.push_str(nasal);
                return out;
            }
            if plain.is_empty() {
                // After a vowel the ending is an independent vowel plus nasal.
                let independent = if vowel == "o" { "ओ" } else { "ए" };
                if out.ends_with(independent) {
                    out.push('ं');
                    return out;
                }
            }
        }
    }
    let mut out = String::new();
    let mut pos = 0;
    let mut after_consonant = false;
    let mut seen_vowel = false;
    let mut prev_consonant = "";
    let mut cluster = 0;
    while pos < word.len() {
        if let Some(&(roman, independent, matra)) = match_at(word, pos, VOWELS, |v| v.0) {
            let end = pos + roman.len() == word.len();
            if after_consonant {
                let m = match (roman, end) {
                    ("a", true) if out.chars().count() > 1 || word.len() > 2 => "ा",
                    ("i", true) => "ी",
                    ("u", true) => "ू",
                    _ => matra,
                };
                out.push_str(m);
            } else {
                out.push_str(independent);
            }
            after_consonant = false;
            seen_vowel = true;
            pos += roman.len();
            continue;
        }
        if let Some(&(roman, deva)) = match_at(word, pos, CONSONANTS, |c| c.0) {
            let next = pos + roman.len();
            // Nasal before a consonant, after a vowel: अंदर, ज़िंदगी.
            if roman == "n"
                && !after_consonant
                && !out.is_empty()
                && next < word.len()
                && !is_vowel_start(word, next)
                && !matches!(&word[next..next + 1], "n" | "y" | "h" | "v" | "w")
            {
                out.push_str(ANUSVARA);
                pos = next;
                continue;
            }
            if after_consonant {
                // A cluster at the start of the word (प्यार, क्या) is always a
                // conjunct; inside it, the table decides.
                let conjunct = !seen_vowel || {
                    let j = join(cluster, prev_consonant, roman);
                    cluster += 1;
                    j
                };
                if conjunct {
                    out.push_str(VIRAMA);
                }
            }
            out.push_str(deva);
            after_consonant = true;
            prev_consonant = roman;
            pos = next;
            continue;
        }
        // Anything else (a digit, a stray symbol) passes through unchanged.
        let ch = word[pos..].chars().next().unwrap_or(' ');
        out.push(ch);
        after_consonant = false;
        pos += ch.len_utf8();
    }
    out
}

// ------------------------------------------------------------- core words

/// The words a mechanical reading gets wrong and the pack does not have.
/// Several spellings per word on purpose: lyric sheets are not consistent
/// (`kyun`/`kyon`/`kyu`, `nahi`/`nahin`, `pyaar`/`pyar`).
const CORE: &[(&str, &str)] = &[
    // Pronouns
    ("main", "मैं"), ("mai", "मैं"), ("mein", "में"), ("mujhe", "मुझे"), ("mujhko", "मुझको"),
    ("mujhse", "मुझसे"), ("mera", "मेरा"), ("meri", "मेरी"), ("mere", "मेरे"), ("hum", "हम"),
    ("hame", "हमें"), ("hamein", "हमें"), ("humein", "हमें"), ("humko", "हमको"), ("humse", "हमसे"),
    ("hamse", "हमसे"), ("hamara", "हमारा"), ("humara", "हमारा"), ("hamari", "हमारी"), ("humari", "हमारी"),
    ("hamare", "हमारे"), ("humare", "हमारे"), ("tum", "तुम"), ("tumhe", "तुम्हें"), ("tumhein", "तुम्हें"),
    ("tumko", "तुमको"), ("tumse", "तुमसे"), ("tumhara", "तुम्हारा"), ("tumhari", "तुम्हारी"),
    ("tumhare", "तुम्हारे"), ("tu", "तू"), ("tujhe", "तुझे"), ("tujhko", "तुझको"), ("tujhse", "तुझसे"),
    ("tera", "तेरा"), ("teri", "तेरी"), ("tere", "तेरे"), ("aap", "आप"), ("aapka", "आपका"),
    ("aapki", "आपकी"), ("aapke", "आपके"), ("apna", "अपना"), ("apni", "अपनी"), ("apne", "अपने"),
    ("woh", "वो"), ("wo", "वो"), ("vo", "वो"), ("voh", "वो"), ("ye", "ये"), ("yeh", "ये"),
    ("is", "इस"), ("us", "उस"), ("isse", "इससे"), ("usse", "उससे"), ("unse", "उनसे"), ("inse", "इनसे"),
    ("unka", "उनका"), ("unki", "उनकी"), ("unke", "उनके"), ("uska", "उसका"), ("uski", "उसकी"),
    ("uske", "उसके"), ("iska", "इसका"), ("iski", "इसकी"), ("iske", "इसके"), ("use", "उसे"), ("ise", "इसे"),
    ("unhe", "उन्हें"), ("unhein", "उन्हें"), ("koi", "कोई"), ("kuch", "कुछ"), ("kuchh", "कुछ"),
    ("sab", "सब"), ("sabhi", "सभी"), ("sabko", "सबको"), ("sabse", "सबसे"), ("khud", "ख़ुद"),
    // Question words and connectives
    ("kya", "क्या"), ("kyun", "क्यों"), ("kyon", "क्यों"), ("kyu", "क्यों"), ("kaise", "कैसे"),
    ("kaisa", "कैसा"), ("kaisi", "कैसी"), ("kab", "कब"), ("kahan", "कहाँ"), ("kahaan", "कहाँ"),
    ("kidhar", "किधर"), ("kaun", "कौन"), ("kon", "कौन"), ("kitna", "कितना"), ("kitni", "कितनी"),
    ("kitne", "कितने"), ("jab", "जब"), ("tab", "तब"), ("ab", "अब"), ("phir", "फिर"), ("fir", "फिर"),
    ("aur", "और"), ("ya", "या"), ("bhi", "भी"), ("hi", "ही"), ("to", "तो"), ("toh", "तो"),
    ("magar", "मगर"), ("lekin", "लेकिन"), ("par", "पर"), ("agar", "अगर"), ("jo", "जो"), ("jis", "जिस"),
    ("jise", "जिसे"), ("jinhe", "जिन्हें"), ("jahan", "जहाँ"), ("jahaan", "जहाँ"), ("wahan", "वहाँ"),
    ("waha", "वहाँ"), ("yahan", "यहाँ"), ("yahaan", "यहाँ"), ("yaha", "यहाँ"), ("jaise", "जैसे"),
    ("jaisa", "जैसा"), ("jaisi", "जैसी"), ("aise", "ऐसे"), ("aisa", "ऐसा"), ("aisi", "ऐसी"),
    ("waise", "वैसे"), ("kyunki", "क्योंकि"), ("isliye", "इसलिए"),
    // Postpositions and particles
    ("se", "से"), ("ka", "का"), ("ki", "की"), ("ke", "के"), ("ko", "को"), ("ne", "ने"), ("me", "में"),
    ("pe", "पे"), ("tak", "तक"), ("sath", "साथ"), ("saath", "साथ"), ("bina", "बिना"), ("liye", "लिए"),
    ("lie", "लिए"), ("na", "ना"), ("naa", "ना"), ("nahi", "नहीं"), ("nahin", "नहीं"), ("nai", "नहीं"),
    ("mat", "मत"), ("haan", "हाँ"), ("han", "हाँ"), ("sang", "संग"), ("bas", "बस"), ("sirf", "सिर्फ़"),
    // Auxiliaries
    ("hai", "है"), ("hain", "हैं"), ("hoon", "हूँ"), ("hun", "हूँ"), ("hu", "हूँ"), ("ho", "हो"),
    ("tha", "था"), ("thi", "थी"), ("the", "थे"), ("hoga", "होगा"), ("hogi", "होगी"), ("honge", "होंगे"),
    ("hona", "होना"), ("hota", "होता"), ("hoti", "होती"), ("hote", "होते"), ("raha", "रहा"),
    ("rahi", "रही"), ("rahe", "रहे"), ("gaya", "गया"), ("gayi", "गई"), ("gaye", "गए"), ("diya", "दिया"),
    ("liya", "लिया"), ("kiya", "किया"), ("hua", "हुआ"), ("hui", "हुई"), ("hue", "हुए"),
    // Time and amount
    ("aaj", "आज"), ("kal", "कल"), ("abhi", "अभी"), ("kabhi", "कभी"), ("sada", "सदा"),
    ("hamesha", "हमेशा"), ("humesha", "हमेशा"), ("ek", "एक"), ("do", "दो"), ("teen", "तीन"),
    ("saare", "सारे"), ("sare", "सारे"), ("sara", "सारा"), ("saari", "सारी"), ("sari", "सारी"),
    ("bahut", "बहुत"), ("bohot", "बहुत"), ("bahot", "बहुत"), ("zara", "ज़रा"), ("thoda", "थोड़ा"),
    ("thodi", "थोड़ी"), ("thode", "थोड़े"), ("har", "हर"), ("kisi", "किसी"), ("kisne", "किसने"),
    ("pehli", "पहली"), ("pehla", "पहला"), ("pehle", "पहले"), ("baar", "बार"), ("pal", "पल"),
    ("waqt", "वक़्त"), ("din", "दिन"), ("raat", "रात"), ("subah", "सुबह"), ("shaam", "शाम"),
    ("sham", "शाम"),
    // Verbs
    ("karo", "करो"), ("karna", "करना"), ("karke", "करके"), ("kar", "कर"), ("karta", "करता"),
    ("karti", "करती"), ("karte", "करते"), ("karu", "करूँ"), ("karun", "करूँ"), ("kehna", "कहना"),
    ("kehta", "कहता"), ("kehti", "कहती"), ("kaha", "कहा"), ("keh", "कह"), ("kahe", "कहे"),
    ("sun", "सुन"), ("suno", "सुनो"), ("suna", "सुना"), ("dekh", "देख"), ("dekho", "देखो"),
    ("dekha", "देखा"), ("dekhe", "देखे"), ("chal", "चल"), ("chalo", "चलो"), ("chala", "चला"),
    ("chali", "चली"), ("chale", "चले"), ("aa", "आ"), ("aaja", "आजा"), ("aana", "आना"), ("aaya", "आया"),
    ("aayi", "आई"), ("aaye", "आए"), ("aate", "आते"), ("aata", "आता"), ("aati", "आती"), ("ja", "जा"),
    ("jaa", "जा"), ("jao", "जाओ"), ("jaana", "जाना"), ("jana", "जाना"), ("jaate", "जाते"),
    ("jaata", "जाता"), ("jaati", "जाती"), ("jaye", "जाए"), ("jaaye", "जाए"), ("mil", "मिल"),
    ("milna", "मिलना"), ("mila", "मिला"), ("mili", "मिली"), ("mile", "मिले"), ("de", "दे"),
    ("dena", "देना"), ("le", "ले"), ("lo", "लो"), ("lena", "लेना"), ("rah", "रह"), ("reh", "रह"),
    ("rehna", "रहना"), ("rehta", "रहता"), ("rehti", "रहती"), ("rehte", "रहते"), ("ban", "बन"),
    ("bana", "बना"), ("bani", "बनी"), ("bane", "बने"), ("lag", "लग"), ("laga", "लगा"), ("lagi", "लगी"),
    ("lage", "लगे"), ("lagta", "लगता"), ("lagti", "लगती"), ("chahiye", "चाहिए"), ("chahta", "चाहता"),
    ("chahti", "चाहती"), ("chahu", "चाहूँ"), ("chahun", "चाहूँ"), ("soch", "सोच"), ("socha", "सोचा"),
    ("samajh", "समझ"), ("jee", "जी"), ("ji", "जी"), ("jeena", "जीना"), ("jina", "जीना"),
    ("marna", "मरना"), ("mar", "मर"), ("ro", "रो"), ("rona", "रोना"), ("hans", "हँस"),
    ("hansna", "हँसना"), ("ruk", "रुक"), ("ruko", "रुको"), ("chhod", "छोड़"), ("chhodo", "छोड़ो"),
    ("chhoda", "छोड़ा"), ("tod", "तोड़"), ("todo", "तोड़ो"), ("toota", "टूटा"), ("tuta", "टूटा"),
    ("tooti", "टूटी"), ("toote", "टूटे"), ("bhar", "भर"),
    // Places and directions
    ("upar", "ऊपर"), ("neeche", "नीचे"), ("andar", "अंदर"), ("bahar", "बाहर"), ("paas", "पास"),
    ("door", "दूर"), ("dur", "दूर"), ("kareeb", "क़रीब"), ("ghar", "घर"), ("raah", "राह"),
    ("raste", "रास्ते"), ("rasta", "रास्ता"), ("safar", "सफ़र"), ("manzil", "मंज़िल"),
    ("zameen", "ज़मीन"), ("zamin", "ज़मीन"), ("duniya", "दुनिया"), ("aasmaan", "आसमान"),
    ("aasman", "आसमान"),
    // The love-song vocabulary
    ("dil", "दिल"), ("pyaar", "प्यार"), ("pyar", "प्यार"), ("ishq", "इश्क़"), ("mohabbat", "मोहब्बत"),
    ("muhabbat", "मुहब्बत"), ("prem", "प्रेम"), ("jaan", "जान"), ("sanam", "सनम"), ("saajan", "साजन"),
    ("sajan", "साजन"), ("sajna", "सजना"), ("yaar", "यार"), ("yaara", "यारा"), ("dost", "दोस्त"),
    ("zindagi", "ज़िंदगी"), ("jindagi", "ज़िंदगी"), ("aankh", "आँख"), ("aankhen", "आँखें"),
    ("aankhein", "आँखें"), ("aankhon", "आँखों"), ("nazar", "नज़र"), ("nazrein", "नज़रें"),
    ("chehra", "चेहरा"), ("khwab", "ख़्वाब"), ("khwaab", "ख़्वाब"), ("sapna", "सपना"), ("sapne", "सपने"),
    ("yaad", "याद"), ("yaadein", "यादें"), ("baat", "बात"), ("baatein", "बातें"), ("dard", "दर्द"),
    ("gham", "ग़म"), ("gam", "ग़म"), ("khushi", "ख़ुशी"), ("aansu", "आँसू"), ("chaand", "चाँद"),
    ("chand", "चाँद"), ("taare", "तारे"), ("sitare", "सितारे"), ("baarish", "बारिश"), ("hawa", "हवा"),
    ("pani", "पानी"), ("paani", "पानी"), ("aag", "आग"), ("rang", "रंग"), ("dhadkan", "धड़कन"),
    ("saans", "साँस"), ("saansein", "साँसें"), ("rooh", "रूह"), ("khuda", "ख़ुदा"), ("rab", "रब"),
    ("akela", "अकेला"), ("akeli", "अकेली"), ("tanha", "तन्हा"), ("deewana", "दीवाना"),
    ("diwana", "दीवाना"), ("deewani", "दीवानी"), ("diwani", "दीवानी"), ("pagal", "पागल"),
    ("dilbar", "दिलबर"), ("mehboob", "महबूब"), ("humsafar", "हमसफ़र"), ("saathiya", "साथिया"),
    ("sathiya", "साथिया"), ("saathi", "साथी"), ("sathi", "साथी"), ("maula", "मौला"),
    ("junoon", "जुनून"), ("sukoon", "सुकून"), ("nasha", "नशा"), ("jaadu", "जादू"), ("jadu", "जादू"),
    ("intezaar", "इंतज़ार"), ("intezar", "इंतज़ार"), ("wada", "वादा"), ("waada", "वादा"),
    ("vaada", "वादा"), ("kasam", "क़सम"), ("dua", "दुआ"), ("duaa", "दुआ"), ("aashiq", "आशिक़"),
    ("ashiq", "आशिक़"), ("aashiqui", "आशिक़ी"), ("mehfil", "महफ़िल"), ("geet", "गीत"),
    ("gaana", "गाना"), ("haath", "हाथ"), ("hath", "हाथ"), ("honth", "होंठ"), ("baahon", "बाहों"),
    ("bahon", "बाहों"), ("baahein", "बाहें"), ("nain", "नैन"), ("naina", "नैना"), ("palkon", "पलकों"),
    ("zulf", "ज़ुल्फ़"), ("payal", "पायल"), ("mehndi", "मेहंदी"), ("dulhan", "दुल्हन"), ("shaadi", "शादी"),
    ("ladki", "लड़की"), ("ladka", "लड़का"), ("log", "लोग"), ("logon", "लोगों"), ("maa", "माँ"),
    ("theek", "ठीक"), ("thik", "ठीक"), ("accha", "अच्छा"), ("achha", "अच्छा"), ("acha", "अच्छा"),
    ("achhi", "अच्छी"), ("acchi", "अच्छी"), ("bura", "बुरा"), ("sach", "सच"), ("sacha", "सच्चा"),
    ("jhooth", "झूठ"), ("jhoot", "झूठ"), ("mausam", "मौसम"), ("dhoop", "धूप"), ("khaali", "ख़ाली"),
    ("khali", "ख़ाली"), ("poora", "पूरा"), ("pura", "पूरा"), ("adhoora", "अधूरा"), ("adhura", "अधूरा"),
    ("dhol", "ढोल"),
    // Punjabi, common in Hindi-language pop
    ("tenu", "तैनू"), ("tainu", "तैनू"), ("mainu", "मैनू"), ("sanu", "सानू"), ("hor", "होर"),
    ("gal", "गल"), ("gallan", "गल्लाँ"), ("nal", "नाल"), ("naal", "नाल"), ("vich", "विच"),
    ("sohni", "सोहणी"), ("sohna", "सोहणा"), ("soniye", "सोणिए"), ("soniya", "सोणिया"),
    ("kudi", "कुड़ी"), ("munda", "मुंडा"), ("mahi", "माही"), ("ve", "वे"), ("ni", "नी"),
];

/// Words that are English and nothing else in a Hinglish lyric. Deliberately
/// leaves out anything that is also a Hindi spelling (`main`, `me`, `to`,
/// `the`, `is`, `do`, `hi`, `ho`, `na`, `par`, `bas`): those are decided by
/// the line around them, via `CORE`.
const ENGLISH: &[&str] = &[
    "i", "im", "you", "your", "youre", "my", "mine", "we", "our", "they", "their", "he", "she", "her",
    "him", "his", "it", "its", "this", "that", "these", "those", "a", "an", "and", "or", "but", "of",
    "for", "with", "without", "on", "at", "from", "into", "about", "are", "am", "was", "were", "be",
    "been", "being", "have", "had", "will", "would", "could", "should", "can", "cant", "dont", "wont",
    "not", "no", "yes", "yeah", "oh", "ooh", "hey", "yo", "baby", "babe", "love", "lover", "girl", "boy",
    "night", "tonight", "day", "party", "dance", "music", "heart", "world", "life", "time", "never",
    "ever", "forever", "all", "just", "like", "come", "go", "get", "got", "let", "lets", "now", "right",
    "one", "more", "say", "said", "tell", "told", "back", "up", "down", "out", "know", "want", "need",
    "feel", "feeling", "what", "when", "why", "how", "where", "who", "so", "too", "very", "only",
    "everything", "nothing", "something", "someone", "everybody", "somebody", "nobody", "always",
    "away", "again", "make", "made", "take", "took", "give", "gave", "keep", "stay", "hold", "hand",
    "eyes", "dream", "dreams", "fire", "light", "dark", "sky", "high", "low", "fly", "run", "fall",
    "rise", "beautiful", "pretty", "crazy", "wild", "free", "alive", "gonna", "wanna", "gotta",
];

fn core_map() -> &'static HashMap<&'static str, &'static str> {
    static MAP: std::sync::OnceLock<HashMap<&'static str, &'static str>> = std::sync::OnceLock::new();
    MAP.get_or_init(|| CORE.iter().copied().collect())
}

fn english_set() -> &'static HashSet<&'static str> {
    static SET: std::sync::OnceLock<HashSet<&'static str>> = std::sync::OnceLock::new();
    SET.get_or_init(|| ENGLISH.iter().copied().collect())
}

// ------------------------------------------------------------ line handling

/// A line split into words (ASCII letters, with apostrophes kept inside a
/// word so `don't` stays one English token) and everything between them.
enum Piece<'a> {
    Word(&'a str),
    Other(&'a str),
}

fn split(line: &str) -> Vec<Piece<'_>> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < line.len() {
        let start = i;
        let is_word = |b: u8| b.is_ascii_alphabetic();
        if is_word(bytes[i]) {
            while i < line.len()
                && (is_word(bytes[i]) || (bytes[i] == b'\'' && i + 1 < line.len() && is_word(bytes[i + 1])))
            {
                i += 1;
            }
            out.push(Piece::Word(&line[start..i]));
        } else {
            // Advance by whole chars: a line may already hold Devanagari.
            let ch = line[i..].chars().next().unwrap_or(' ');
            i += ch.len_utf8();
            while i < line.len() && !is_word(bytes[i]) {
                let ch = line[i..].chars().next().unwrap_or(' ');
                i += ch.len_utf8();
            }
            out.push(Piece::Other(&line[start..i]));
        }
    }
    out
}

fn normalized(word: &str) -> String {
    word.to_ascii_lowercase().replace('\'', "")
}

/// Every distinct lowercase word in `lines`, for loading only the part of
/// the pack a song actually needs.
fn words_in(lines: &[String]) -> HashSet<String> {
    let mut set = HashSet::new();
    for line in lines {
        for piece in split(line) {
            if let Piece::Word(w) = piece {
                set.insert(normalized(w));
            }
        }
    }
    set
}

/// Is this line English rather than romanized Hindi? Counts unambiguous
/// English words against known Hindi words; ambiguous ones (`to`, `main`)
/// count for neither side. Any English with no Hindi at all is English
/// (`don't stop`); a mix needs English to clearly win.
fn is_english_line(words: &[String]) -> bool {
    let english = english_set();
    let core = core_map();
    let en = words.iter().filter(|w| english.contains(w.as_str()) && !core.contains_key(w.as_str())).count();
    let hi = words.iter().filter(|w| core.contains_key(w.as_str()) && !english.contains(w.as_str())).count();
    (en >= 1 && hi == 0) || (en >= 2 && en > hi)
}

fn word_to_devanagari(original: &str, lexicon: &HashMap<String, String>) -> String {
    if original.contains('\'') {
        return original.to_string(); // an English contraction
    }
    let w = normalized(original);
    if let Some(d) = core_map().get(w.as_str()) {
        return (*d).to_string();
    }
    if english_set().contains(w.as_str()) {
        return original.to_string();
    }
    if let Some(d) = lexicon.get(&w) {
        return d.clone();
    }
    rules(&w)
}

/// One lyric line to Devanagari.
pub(crate) fn line_to_devanagari(line: &str, lexicon: &HashMap<String, String>) -> String {
    let pieces = split(line);
    let words: Vec<String> = pieces
        .iter()
        .filter_map(|p| if let Piece::Word(w) = p { Some(normalized(w)) } else { None })
        .collect();
    if words.is_empty() || is_english_line(&words) {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len() * 3);
    for piece in pieces {
        match piece {
            Piece::Word(w) => out.push_str(&word_to_devanagari(w, lexicon)),
            Piece::Other(o) => out.push_str(o),
        }
    }
    out
}

/// Transliterate a cue list, preserving every timing field.
pub(crate) fn cues_to_devanagari(cues: &[Cue], lexicon: &HashMap<String, String>) -> Vec<Cue> {
    cues.iter()
        .map(|c| Cue {
            time_ms: c.time_ms,
            text: line_to_devanagari(&c.text, lexicon),
            end_ms: c.end_ms,
            words: None,
        })
        .collect()
}

// --------------------------------------------------------------- the pack

/// Aksharantar's Hindi archive at an exact dataset revision, with the SHA-256
/// and size of the actual download — the same pinning `models.rs` uses, for
/// the same reason: "the file at this URL" is not a stable identity on its own.
pub(crate) const PACK_ZIP: crate::models::ModelFile = crate::models::ModelFile::new(
    "aksharantar-hin.zip",
    "https://huggingface.co/datasets/ai4bharat/Aksharantar/resolve/e418c1fc928d9f5393af33268472cf20c1891be8/hin.zip",
    "208c2d1b128234e6dc777b750779b4f5e6214ab43244039349b530bf9868bdaf",
    33_100_386,
);

const LEXICON_FILE: &str = "hindi-lexicon.tsv";

fn pack_dir(app: &AppHandle) -> Option<PathBuf> {
    crate::inference::model_dir(app)
}

pub(crate) fn lexicon_path(app: &AppHandle) -> Option<PathBuf> {
    pack_dir(app).map(|d| d.join(LEXICON_FILE))
}

pub(crate) fn pack_installed(app: &AppHandle) -> bool {
    lexicon_path(app).map(|p| p.is_file()).unwrap_or(false)
}

/// Load just the entries for `wanted` from the lexicon file. Not a resident
/// map: the whole lexicon is ~1M entries, and holding that all session to
/// serve a few hundred words per song would be tens of MB for nothing. The
/// file is sorted (`build_lexicon` writes it that way), so each wanted word is
/// a binary search over byte offsets in the file, seeking to the line under
/// each probe — about 20 small reads per word instead of reading 37MB.
fn load_lexicon(path: &Path, wanted: &HashSet<String>) -> HashMap<String, String> {
    use std::io::{Seek, SeekFrom};
    let mut found = HashMap::new();
    let Ok(mut file) = std::fs::File::open(path) else { return found };
    let Ok(len) = file.metadata().map(|m| m.len()) else { return found };
    // The first full line starting at or after `pos`.
    let mut line_at = |pos: u64| -> Option<(u64, String)> {
        // Start one byte early and skip to the next newline: at a line start
        // that consumes just the previous line's '\n', mid-line it finishes
        // the line. Starting at `pos` itself would skip a line that begins
        // exactly there (the bug the live test caught).
        let from = pos.saturating_sub(1);
        file.seek(SeekFrom::Start(from)).ok()?;
        let mut reader = BufReader::with_capacity(512, &mut file);
        let mut start = 0;
        if pos > 0 {
            let mut partial = Vec::new();
            start = from + reader.read_until(b'\n', &mut partial).ok()? as u64;
        }
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        if line.is_empty() {
            return None;
        }
        Some((start, line.trim_end_matches('\n').to_string()))
    };
    for word in wanted {
        // Invariant: the line for `word`, if any, starts in [lo, hi).
        let (mut lo, mut hi) = (0u64, len);
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let Some((start, line)) = line_at(mid) else {
                hi = mid;
                continue;
            };
            let (key, deva) = line.split_once('\t').unwrap_or((line.as_str(), ""));
            match key.cmp(word.as_str()) {
                std::cmp::Ordering::Equal => {
                    found.insert(word.clone(), deva.to_string());
                    break;
                }
                std::cmp::Ordering::Less => lo = start + line.len() as u64 + 1,
                // The line found starts at or after `mid`; anything earlier
                // than it is still a candidate, including the line `mid` was in.
                std::cmp::Ordering::Greater => hi = mid,
            }
        }
    }
    found
}

/// Transliterate `cues` with whatever this install has: core words and rules
/// always, the pack's lexicon when it has been downloaded.
pub(crate) fn transliterate(app: &AppHandle, cues: &[Cue]) -> Vec<Cue> {
    let texts: Vec<String> = cues.iter().map(|c| c.text.clone()).collect();
    let lexicon = match lexicon_path(app) {
        Some(p) if p.is_file() => load_lexicon(&p, &words_in(&texts)),
        _ => HashMap::new(),
    };
    cues_to_devanagari(cues, &lexicon)
}

/// Is `deva` a plausible Devanagari spelling? Aksharantar is mined, and some
/// of it is noise: doubled matras (हैैै), stray Latin, nothing at all.
fn clean_candidate(deva: &str) -> bool {
    if deva.is_empty() || !deva.chars().all(|c| ('\u{0900}'..='\u{097F}').contains(&c) || c == '\u{200C}' || c == '\u{200D}') {
        return false;
    }
    let chars: Vec<char> = deva.chars().collect();
    // A dependent vowel sign or virama twice in a row is never a real word.
    let is_sign = |c: char| ('\u{093E}'..='\u{094D}').contains(&c);
    !chars.windows(2).any(|w| is_sign(w[0]) && is_sign(w[1]))
}

/// Levenshtein distance over chars — for ranking a word's candidates by how
/// close each is to what `rules` would have produced.
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != cb)).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Build the lexicon from Aksharantar's JSON-lines records (one object per
/// line, with "english word" and "native word"). Per romanized word: drop
/// noisy spellings, then keep the most frequent; ties go to the one closest
/// to the rule reading, which is the tie-break that picks प्यार over प्रयॉर.
pub(crate) fn build_lexicon(records: impl BufRead, out: &Path) -> Result<usize, String> {
    let mut candidates: HashMap<String, HashMap<String, u32>> = HashMap::new();
    for line in records.lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let (Some(roman), Some(deva)) = (v["english word"].as_str(), v["native word"].as_str()) else { continue };
        let roman = roman.trim().to_ascii_lowercase();
        if roman.is_empty() || roman.len() > 30 || !roman.bytes().all(|b| b.is_ascii_lowercase()) {
            continue;
        }
        if !clean_candidate(deva) {
            continue;
        }
        *candidates.entry(roman).or_default().entry(deva.to_string()).or_default() += 1;
    }
    let mut rows: Vec<(String, String)> = candidates
        .into_iter()
        .filter_map(|(roman, natives)| {
            let ruled = rules(&roman);
            let best = natives
                .into_iter()
                .min_by_key(|(d, n)| (std::cmp::Reverse(*n), edit_distance(d, &ruled), d.clone()))?;
            Some((roman, best.0))
        })
        .collect();
    rows.sort();
    let tmp = out.with_extension("tsv.part");
    {
        let file = std::fs::File::create(&tmp).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        let mut w = BufWriter::new(file);
        for (roman, deva) in &rows {
            writeln!(w, "{roman}\t{deva}").map_err(|e| e.to_string())?;
        }
        w.flush().map_err(|e| e.to_string())?;
    }
    // Rename into place last, so a crash mid-build never leaves a half
    // lexicon that `pack_installed` would report as done.
    std::fs::rename(&tmp, out).map_err(|e| e.to_string())?;
    Ok(rows.len())
}

/// Download the pack and build the lexicon. Emits `hindi-pack` events:
/// `{stage: "downloading", percent}`, `{stage: "building"}`, then
/// `{stage: "done", words}` or `{stage: "error", message}`.
fn install(app: &AppHandle, cancel: &crate::jobs::CancelToken) -> Result<usize, String> {
    let dir = pack_dir(app).ok_or("no app data directory")?;
    install_into(&dir, &|v| { let _ = app.emit("hindi-pack", v); }, &|| cancel.cancelled())
}

/// `install` without the app handle, so the live test can drive it.
fn install_into(dir: &Path, emit: &dyn Fn(serde_json::Value), cancelled: &dyn Fn() -> bool) -> Result<usize, String> {
    crate::models::ensure(
        dir,
        std::slice::from_ref(&PACK_ZIP),
        |_, pct| emit(json!({ "stage": "downloading", "percent": pct })),
        cancelled,
    )?;
    emit(json!({ "stage": "building" }));
    let zip_path = dir.join(PACK_ZIP.name());
    let file = std::fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("not a zip: {e}"))?;
    // Train + validation + test: all of it is vocabulary to this app.
    let mut all = Vec::new();
    for name in ["hin_train.json", "hin_valid.json", "hin_test.json"] {
        if let Ok(mut entry) = archive.by_name(name) {
            entry.read_to_end(&mut all).map_err(|e| e.to_string())?;
            all.push(b'\n');
        }
    }
    if all.is_empty() {
        return Err("the pack contained no word lists".into());
    }
    let out = dir.join(LEXICON_FILE);
    let words = build_lexicon(std::io::Cursor::new(all), &out)?;
    // The archive has served its purpose; 33MB is not worth keeping for a
    // rebuild that would produce the same file.
    let _ = std::fs::remove_file(&zip_path);
    Ok(words)
}

struct InstallJob {
    app: AppHandle,
}

impl crate::jobs::Runnable for InstallJob {
    fn lane(&self) -> crate::jobs::Lane {
        crate::jobs::Lane::Io
    }
    fn dedup_key(&self) -> String {
        "hindi-pack".into()
    }
    fn run(self: Box<Self>, cancel: &crate::jobs::CancelToken) {
        let msg = match install(&self.app, cancel) {
            Ok(words) => json!({ "stage": "done", "words": words }),
            Err(message) => json!({ "stage": "error", "message": message }),
        };
        let _ = self.app.emit("hindi-pack", msg);
    }
}

#[tauri::command]
pub(crate) fn hindi_pack_status(app: AppHandle) -> serde_json::Value {
    json!({
        "installed": pack_installed(&app),
        "downloadBytes": PACK_ZIP.size(),
    })
}

/// Start (or join) the pack download. Returns at once; progress arrives as
/// `hindi-pack` events. Through the job engine, so a second click while one
/// is running is deduplicated rather than starting a second 33MB fetch.
#[tauri::command]
pub(crate) fn hindi_pack_download(app: AppHandle) -> bool {
    crate::jobs::submit(InstallJob { app }, crate::jobs::Priority::Next)
}

#[tauri::command]
pub(crate) fn hindi_pack_remove(app: AppHandle) -> bool {
    lexicon_path(&app).map(|p| std::fs::remove_file(p).is_ok()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none() -> HashMap<String, String> {
        HashMap::new()
    }

    #[test]
    fn rules_read_common_spellings() {
        for (roman, want) in [
            ("dil", "दिल"),
            ("mera", "मेरा"),
            ("zindagi", "ज़िंदगी"),
            ("andar", "अंदर"),
            ("aaye", "आये"),
            ("sanam", "सनम"),
            ("panna", "पन्ना"),
            ("dilli", "दिल्ली"),
            ("ishq", "इश्क़"),
            ("accha", "अच्छा"),
            ("raaton", "रातों"),
            ("baaten", "बातें"),
            ("galiyon", "गलियों"),
            ("jaaon", "जाओं"),
        ] {
            assert_eq!(rules(roman), want, "{roman}");
        }
    }

    #[test]
    fn core_words_beat_the_rules() {
        // The mechanical reading of these is wrong, which is why CORE exists.
        assert_eq!(rules("main"), "मैन");
        assert_eq!(line_to_devanagari("main", &none()), "मैं");
        assert_eq!(line_to_devanagari("kyun", &none()), "क्यों");
    }

    #[test]
    fn a_hindi_line_keeps_its_punctuation_and_spacing() {
        assert_eq!(line_to_devanagari("Tum hi ho, meri zindagi!", &none()), "तुम ही हो, मेरी ज़िंदगी!");
    }

    #[test]
    fn english_lines_and_words_stay_latin() {
        assert_eq!(line_to_devanagari("I love you baby", &none()), "I love you baby");
        assert_eq!(line_to_devanagari("Oh baby tu meri jaan", &none()), "Oh baby तू मेरी जान");
        assert_eq!(line_to_devanagari("don't stop", &none()), "don't stop");
    }

    #[test]
    fn devanagari_and_empty_lines_pass_through() {
        assert_eq!(line_to_devanagari("तुम ही हो", &none()), "तुम ही हो");
        assert_eq!(line_to_devanagari("", &none()), "");
        assert_eq!(line_to_devanagari("♪ ♪", &none()), "♪ ♪");
    }

    #[test]
    fn the_lexicon_is_used_for_words_core_does_not_know() {
        let mut lex = HashMap::new();
        lex.insert("khwahish".to_string(), "ख़्वाहिश".to_string());
        assert_eq!(line_to_devanagari("teri khwahish", &lex), "तेरी ख़्वाहिश");
    }

    #[test]
    fn cue_timing_survives() {
        let cues = vec![Cue { time_ms: 1200, text: "dil".into(), end_ms: Some(2400), words: None }];
        let out = cues_to_devanagari(&cues, &none());
        assert_eq!(out[0].time_ms, 1200);
        assert_eq!(out[0].end_ms, Some(2400));
        assert_eq!(out[0].text, "दिल");
    }

    #[test]
    fn noisy_candidates_are_rejected() {
        assert!(clean_candidate("प्यार"));
        assert!(!clean_candidate("हैैै"), "doubled matras");
        assert!(!clean_candidate("pyar"));
        assert!(!clean_candidate(""));
    }

    #[test]
    fn building_prefers_frequency_then_the_rule_reading() {
        let data = [
            r#"{"english word": "pyar", "native word": "प्रयॉर"}"#,
            r#"{"english word": "pyar", "native word": "प्यार"}"#,
            r#"{"english word": "hai", "native word": "हैैै"}"#,
            r#"{"english word": "naam", "native word": "नाम"}"#,
            r#"{"english word": "naam", "native word": "नम"}"#,
            r#"{"english word": "naam", "native word": "नम"}"#,
        ]
        .join("\n");
        let dir = std::env::temp_dir().join(format!("hindi-lex-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("lex.tsv");
        let n = build_lexicon(std::io::Cursor::new(data), &out).unwrap();
        assert_eq!(n, 2, "the all-noise word is dropped");
        let text = std::fs::read_to_string(&out).unwrap();
        assert_eq!(text, "naam\tनम\npyar\tप्यार\n");
        let wanted: HashSet<String> = ["pyar".to_string()].into();
        assert_eq!(load_lexicon(&out, &wanted).get("pyar").map(String::as_str), Some("प्यार"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The real download: fetch the pinned archive, verify it, build the
    /// lexicon. Network, ~33MB: `cargo test --workspace -- --ignored
    /// hindi_pack_installs --nocapture`.
    #[test]
    #[ignore]
    fn hindi_pack_installs() {
        let dir = std::env::temp_dir().join(format!("hindi-pack-{}", std::process::id()));
        // HINDI_PACK_ZIP pre-seeds an already-downloaded archive (behind a
        // TLS-intercepting proxy, say); ensure() then skips the fetch.
        if let Ok(zip) = std::env::var("HINDI_PACK_ZIP") {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::copy(zip, dir.join(PACK_ZIP.name())).unwrap();
        }
        let started = std::time::Instant::now();
        let words = install_into(&dir, &|_| {}, &|| false).expect("install");
        let lex = dir.join(LEXICON_FILE);
        let size = std::fs::metadata(&lex).unwrap().len();
        println!("hindi_pack_installs: {words} words, {size} bytes, {:.1}s", started.elapsed().as_secs_f64());
        assert!(words > 500_000, "only {words} words");
        assert!(!dir.join(PACK_ZIP.name()).exists(), "the archive is deleted after the build");
        let wanted: HashSet<String> = ["mohabbatein".to_string()].into();
        let scan = std::time::Instant::now();
        assert_eq!(load_lexicon(&lex, &wanted).get("mohabbatein").map(String::as_str), Some("मोहब्बतें"));
        println!("hindi_pack_installs: one lookup scan {:.0}ms", scan.elapsed().as_secs_f64() * 1000.0);
        // Every 500th entry, first and last included, must come back exactly;
        // words that are not in the file must not.
        let text = std::fs::read_to_string(&lex).unwrap();
        let all: Vec<(&str, &str)> = text.lines().filter_map(|l| l.split_once('\t')).collect();
        let mut sample: Vec<(&str, &str)> = all.iter().step_by(500).copied().collect();
        sample.push(*all.last().unwrap());
        let mut wanted: HashSet<String> = sample.iter().map(|(k, _)| k.to_string()).collect();
        for absent in ["", "zzzzzzzzzzzz", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] {
            wanted.insert(absent.to_string());
        }
        let scan = std::time::Instant::now();
        let got = load_lexicon(&lex, &wanted);
        println!("hindi_pack_installs: {} lookups in {:.0}ms", wanted.len(), scan.elapsed().as_secs_f64() * 1000.0);
        for (k, v) in &sample {
            assert_eq!(got.get(*k).map(String::as_str), Some(*v), "{k}");
        }
        assert_eq!(got.len(), sample.len(), "absent words must not be found");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Learn `SEPARATE`: for every training word, flip each word-internal
    /// cluster between conjunct and separate and vote for whichever reading
    /// is closer to the real spelling. Prints the pairs where "separate"
    /// wins. `HINDI_TEST_DIR=... cargo test --workspace --release -- --ignored
    /// learn_joins --nocapture`.
    #[test]
    #[ignore]
    fn learn_joins() {
        let dir = PathBuf::from(std::env::var("HINDI_TEST_DIR").expect("set HINDI_TEST_DIR"));
        let mut votes: HashMap<(String, String), (u32, u32)> = HashMap::new();
        for line in std::fs::read_to_string(dir.join("hin_train.json")).unwrap().lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let (Some(r), Some(gold)) = (v["english word"].as_str(), v["native word"].as_str()) else { continue };
            let r = r.to_ascii_lowercase();
            if !r.bytes().all(|b| b.is_ascii_lowercase()) || !clean_candidate(gold) {
                continue;
            }
            let mut pairs = Vec::new();
            let base = rules_with(&r, &mut |_, a, b| {
                pairs.push((a.to_string(), b.to_string()));
                true
            });
            let d_join = edit_distance(&base, gold);
            for (i, pair) in pairs.iter().enumerate() {
                let alt = rules_with(&r, &mut |k, _, _| k != i);
                let d_sep = edit_distance(&alt, gold);
                let e = votes.entry(pair.clone()).or_default();
                if d_sep < d_join {
                    e.1 += 1;
                } else if d_join < d_sep {
                    e.0 += 1;
                }
            }
        }
        let mut sep: Vec<_> = votes.into_iter().filter(|(_, (j, s))| j + s >= 30 && s > j).collect();
        sep.sort();
        for ((a, b), (j, s)) in &sep {
            println!("learned (\"{a}\", \"{b}\"), // {s} vs {j}");
        }
    }

    /// Exact-match accuracy on Aksharantar's held-out Hindi test split, rules
    /// alone and with a lexicon built from the train split. Needs the
    /// unzipped files: `HINDI_TEST_DIR=<dir with hin_train.json and
    /// hin_test.json> cargo test --workspace -- --ignored hindi_accuracy --nocapture`.
    #[test]
    #[ignore]
    fn hindi_accuracy() {
        let dir = PathBuf::from(std::env::var("HINDI_TEST_DIR").expect("set HINDI_TEST_DIR"));
        let out = std::env::temp_dir().join("hindi-accuracy.tsv");
        let train = BufReader::new(std::fs::File::open(dir.join("hin_train.json")).unwrap());
        build_lexicon(train, &out).unwrap();
        let test: Vec<(String, String)> = std::fs::read_to_string(dir.join("hin_test.json"))
            .unwrap()
            .lines()
            .filter_map(|l| {
                let v: serde_json::Value = serde_json::from_str(l).ok()?;
                Some((v["english word"].as_str()?.to_ascii_lowercase(), v["native word"].as_str()?.to_string()))
            })
            .collect();
        let wanted: HashSet<String> = test.iter().map(|(r, _)| r.clone()).collect();
        let lex = load_lexicon(&out, &wanted);
        let rules_ok = test.iter().filter(|(r, d)| rules(r) == *d).count();
        let full_ok = test.iter().filter(|(r, d)| word_to_devanagari(r, &lex) == *d).count();
        println!(
            "hindi_accuracy: {} words; rules {:.1}%; core+lexicon+rules {:.1}%",
            test.len(),
            100.0 * rules_ok as f64 / test.len() as f64,
            100.0 * full_ok as f64 / test.len() as f64,
        );
    }
}
