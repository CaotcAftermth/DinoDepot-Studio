//! The embedded Git engine.
//!
//! ## Why embedded
//!
//! Synchronization has to work on a machine that has never had Git installed,
//! and an administrator must never be asked to install it. Shelling out to
//! `git.exe` would also mean the token reaching a child process's environment
//! or command line, where it is visible to anything that can list processes.
//!
//! ## Why libgit2 (`git2`)
//!
//! Chosen after building both candidates on Windows against the actual
//! requirement set — fetch, tree access, commit creation, ref updates,
//! credentials, and packaging into a Tauri installer.
//!
//! * **`git2` (libgit2)** — builds on Windows in under a minute with
//!   `vendored-libgit2`, so nothing on the build machine has to supply libgit2.
//!   `features = ["https"]` links Windows' own Schannel rather than bundling
//!   OpenSSL, which means no certificate store to ship and keep current. The
//!   credential callback (`RemoteCallbacks::credentials`) hands a username and
//!   password to the transport per request, which is exactly the in-memory
//!   credential shape needed: the token is never written into a remote URL and
//!   never reaches disk. Push reports per-ref status, so a non-fast-forward
//!   rejection arrives as a distinguishable result rather than as prose.
//!   `git2::Version::get().https()` lets the app assert at runtime that the
//!   build it is actually running has HTTPS compiled in.
//! * **`gix`** — pure Rust and appealing, but its push support is still
//!   incomplete at the time of writing, and push with a non-force guarantee is
//!   the single operation this design cannot compromise on.
//!
//! The whole of libgit2 is confined to this module. Everything outside it talks
//! to the types here, so replacing the implementation later means rewriting one
//! module rather than the synchronization engine.
//!
//! ## What this module does not do
//!
//! It does not merge. A Git-level merge would produce conflict markers inside
//! JSON, which is exactly what the administrator must never see. Reconciliation
//! is semantic and happens above this layer; this module fetches, reads trees,
//! writes commits, and pushes without force.

mod repo;

pub use repo::*;
