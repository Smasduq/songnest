//! SongnestPy-backed [`Extractor`](crate::Extractor): yt-dlp running on the
//! embedded CPython interpreter (Chaquopy) inside the Android app.
//!
//! The interpreter is started on the Android side (`MainActivity.onCreate`,
//! it needs the Activity context) before the Rust backend comes up. Every
//! call below crosses JNI into `com.chaquo.python.Python`, invokes one
//! `songnestpy` module function, and parses the JSON string it returns.
//! Blocking calls run in `spawn_blocking` so the async runtime never stalls
//! on seconds-long JS challenges.
//!
//! Stream choice mirrors `ba`: best audio-only stream, preferring m4a/AAC
//! (plays everywhere) and falling back to whatever yt-dlp picks. The direct
//! URL means no ffmpeg transcode step — there is no ffmpeg on Android.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use async_trait::async_trait;

use crate::{url_expiry, Candidate, Extractor, Stream};

/// Fingerprint of the cookies file the interpreter was told about.
type CookieState = Option<(u64, Option<std::time::SystemTime>)>;

#[derive(Clone, Debug)]
pub struct SongnestPyExtractor {
    /// `<data_dir>/cookies.txt`, handed to yt-dlp when present.
    cookies: Option<String>,
    configured: Arc<AtomicBool>,
    last_cookies: Arc<Mutex<CookieState>>,
}

impl SongnestPyExtractor {
    pub fn new(data_dir: &str) -> Self {
        let cookies = std::path::Path::new(data_dir).join("cookies.txt");
        let cookies = cookies.to_str().map(|s| s.to_string());
        Self {
            cookies,
            configured: Arc::new(AtomicBool::new(false)),
            last_cookies: Arc::new(Mutex::new(None)),
        }
    }

    /// "Logged in" == a non-empty cookies file exists. Checked live so a
    /// pushed `cookies.txt` takes effect without a restart.
    pub fn is_logged_in(&self) -> bool {
        self.cookies
            .as_ref()
            .map(|p| std::fs::metadata(p).map(|m| m.len() > 0).unwrap_or(false))
            .unwrap_or(false)
    }

    fn cookie_state(&self) -> CookieState {
        self.cookies.as_ref().and_then(|p| {
            std::fs::metadata(p)
                .ok()
                .filter(|m| m.len() > 0)
                .map(|m| (m.len(), m.modified().ok()))
        })
    }

    /// Hand the cookies path to the interpreter, re-sending whenever the
    /// file appears, disappears, or changes (a late-added cookies.txt must
    /// take effect without restarting the app).
    async fn ensure_configured(&self) -> anyhow::Result<()> {
        let state = self.cookie_state();
        {
            let last = self.last_cookies.lock().unwrap();
            if self.configured.load(Ordering::Relaxed) && *last == state {
                return Ok(());
            }
        }
        let cfg = serde_json::json!({ "cookies": self.cookies }).to_string();
        let me = self.clone();
        tokio::task::spawn_blocking(move || {
            let out = bridge_call("configure", &cfg)?;
            let v: serde_json::Value = serde_json::from_str(&out)
                .map_err(|e| anyhow::anyhow!("songnestpy configure: bad JSON: {e}"))?;
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                anyhow::bail!("songnestpy configure: {err}");
            }
            *me.last_cookies.lock().unwrap() = state;
            me.configured.store(true, Ordering::Relaxed);
            Ok(())
        })
        .await
        .map_err(|e| anyhow::anyhow!("songnestpy configure task failed: {e}"))?
    }

    async fn call_json(&self, func: &str, arg: &str) -> anyhow::Result<serde_json::Value> {
        self.ensure_configured().await?;
        let (func, arg) = (func.to_string(), arg.to_string());
        let out = tokio::task::spawn_blocking({
            let (func, arg) = (func.clone(), arg.clone());
            move || bridge_call(&func, &arg)
        })
        .await
        .map_err(|e| anyhow::anyhow!("songnestpy {func} task failed: {e}"))??;
        let v: serde_json::Value = serde_json::from_str(&out)
            .map_err(|e| anyhow::anyhow!("songnestpy {func}: bad JSON: {e}"))?;
        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
            anyhow::bail!("songnestpy {func}: {err}");
        }
        Ok(v)
    }
}

/// One synchronous JNI round-trip. Runs on a blocking thread; any thread may
/// call into Chaquopy (it manages the GIL itself).
fn bridge_call(func: &str, arg: &str) -> anyhow::Result<String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (func, arg);
        anyhow::bail!("songnestpy backend is Android-only (embedded CPython)");
    }
    #[cfg(target_os = "android")]
    {
        let ctx = ndk_context::android_context();
        if ctx.vm().is_null() {
            anyhow::bail!("songnestpy: no JVM (not running on Android?)");
        }
        // SAFETY: the pointer comes from ndk-context in our own process.
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| anyhow::anyhow!("songnestpy: bad JVM pointer: {e}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| anyhow::anyhow!("songnestpy: attach failed: {e}"))?;
        let out = bridge_inner(&mut env, &ctx, func, arg);
        // Backstop: detaching (or returning) with a pending Java exception
        // aborts the process, so make sure none is pending no matter what.
        let _ = env.exception_clear();
        out
    }
}

/// One synchronous JNI round-trip on an attached thread. All app classes
/// are resolved through the Activity's own class loader: plain FindClass
/// from a worker thread resolves against the wrong loader and fails.
#[cfg(target_os = "android")]
fn bridge_inner(
    env: &mut jni::JNIEnv,
    ctx: &ndk_context::AndroidContext,
    func: &str,
    arg: &str,
) -> anyhow::Result<String> {
    use jni::objects::{JClass, JObject, JValue};

    {
        // Raise a Java-side traceback to logcat, then fail the call.
        let check_exc = |env: &mut jni::JNIEnv| -> anyhow::Result<()> {
            let pending = env
                .exception_occurred()
                .map_err(|e| anyhow::anyhow!("songnestpy: JNI error: {e}"))?;
            if pending.is_null() {
                return Ok(());
            }
            let _ = env.exception_describe();
            let _ = env.exception_clear();
            anyhow::bail!("songnestpy: Java exception (see logcat SongnestPy)")
        };

        // SAFETY: ndk-context holds this (global) Activity ref for the
        // process lifetime; Tauri initializes it before our code can run.
        let activity = unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };
        if activity.is_null() {
            anyhow::bail!("songnestpy: no Activity (not running on Android?)");
        }
        let loader: JObject = env
            .call_method(
                &activity,
                "getClassLoader",
                "()Ljava/lang/ClassLoader;",
                &[],
            )
            .map_err(|e| anyhow::anyhow!("songnestpy: getClassLoader: {e}"))?
            .l()
            .map_err(|e| anyhow::anyhow!("songnestpy: getClassLoader: {e}"))?;
        check_exc(env)?;
        let cls_name = JObject::from(
            env.new_string("com.chaquo.python.Python")
                .map_err(|e| anyhow::anyhow!("songnestpy: new_string: {e}"))?,
        );
        let py_class: JClass = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::from(&cls_name)],
            )
            .map_err(|e| anyhow::anyhow!("songnestpy: loadClass: {e}"))?
            .l()
            .map_err(|e| anyhow::anyhow!("songnestpy: loadClass: {e}"))?
            .into();
        check_exc(env)?;

        let py: JObject = env
            .call_static_method(
                &py_class,
                "getInstance",
                "()Lcom/chaquo/python/Python;",
                &[],
            )
            .map_err(|e| anyhow::anyhow!("songnestpy: getInstance: {e}"))?
            .l()
            .map_err(|e| anyhow::anyhow!("songnestpy: getInstance: {e}"))?;
        check_exc(env)?;
        let mod_name = JObject::from(
            env.new_string("songnestpy")
                .map_err(|e| anyhow::anyhow!("songnestpy: new_string: {e}"))?,
        );
        let module: JObject = env
            .call_method(
                &py,
                "getModule",
                "(Ljava/lang/String;)Lcom/chaquo/python/PyObject;",
                &[JValue::from(&mod_name)],
            )
            .map_err(|e| anyhow::anyhow!("songnestpy: getModule: {e}"))?
            .l()
            .map_err(|e| anyhow::anyhow!("songnestpy: getModule: {e}"))?;
        check_exc(env)?;
        let fname = JObject::from(
            env.new_string(func)
                .map_err(|e| anyhow::anyhow!("songnestpy: new_string: {e}"))?,
        );
        let farg = JObject::from(
            env.new_string(arg)
                .map_err(|e| anyhow::anyhow!("songnestpy: new_string: {e}"))?,
        );
        let args = env
            .new_object_array(1, "java/lang/Object", &farg)
            .map_err(|e| anyhow::anyhow!("songnestpy: argv: {e}"))?;
        let res: JObject = env
            .call_method(
                &module,
                "callAttr",
                "(Ljava/lang/String;[Ljava/lang/Object;)Lcom/chaquo/python/PyObject;",
                &[JValue::from(&fname), JValue::from(&args)],
            )
            .map_err(|e| anyhow::anyhow!("songnestpy: callAttr {func}: {e}"))?
            .l()
            .map_err(|e| anyhow::anyhow!("songnestpy: callAttr {func}: {e}"))?;
        check_exc(env)?;
        let s: JObject = env
            .call_method(&res, "toString", "()Ljava/lang/String;", &[])
            .map_err(|e| anyhow::anyhow!("songnestpy: toString: {e}"))?
            .l()
            .map_err(|e| anyhow::anyhow!("songnestpy: toString: {e}"))?;
        check_exc(env)?;
        let js: jni::objects::JString = s.into();
        let java_str = env
            .get_string(&js)
            .map_err(|e| anyhow::anyhow!("songnestpy: decode: {e}"))?;
        Ok(std::borrow::Cow::from(&*java_str).into_owned())
    }
}

#[async_trait]
impl Extractor for SongnestPyExtractor {
    async fn search_music(&self, query: &str) -> anyhow::Result<Vec<Candidate>> {
        let v = self.call_json("search_json", query).await?;
        let hits = v
            .get("hits")
            .and_then(|h| h.as_array())
            .ok_or_else(|| anyhow::anyhow!("songnestpy search_json: no hits array"))?;
        Ok(hits
            .iter()
            .take(5)
            .filter_map(|e| {
                // id is load-bearing; everything else degrades gracefully
                // (yt-dlp durations arrive as floats, and flat search rows
                // can miss fields entirely — never drop a hit over that).
                Some(Candidate {
                    id: e.get("id")?.as_str()?.to_string(),
                    title: e
                        .get("title")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string(),
                    duration_secs: e.get("duration").and_then(|d| {
                        d.as_u64().or_else(|| d.as_f64().map(|f| f.max(0.0) as u64))
                    }),
                    channel: e
                        .get("channel")
                        .and_then(|c| c.as_str())
                        .filter(|c| !c.is_empty())
                        .map(|c| c.to_string()),
                })
            })
            .collect())
    }

    async fn resolve(&self, video_id: &str) -> anyhow::Result<Stream> {
        let v = self.call_json("resolve_json", video_id).await?;
        let url = v
            .get("url")
            .and_then(|u| u.as_str())
            .filter(|u| !u.is_empty())
            .ok_or_else(|| anyhow::anyhow!("songnestpy resolve_json: no url"))?
            .to_string();
        let ext = v.get("ext").and_then(|e| e.as_str()).unwrap_or("");
        // yt-dlp `abr` is kbit/s; Stream.bitrate is bit/s.
        let bitrate = v
            .get("abr")
            .and_then(|a| a.as_f64())
            .map(|a| (a * 1000.0) as u64);
        Ok(Stream {
            mime: if ext.contains("webm") {
                "audio/webm".to_string()
            } else {
                "audio/mp4".to_string()
            },
            expires_at: url_expiry(&url),
            headers: Vec::new(),
            bitrate,
            url,
        })
    }
}
