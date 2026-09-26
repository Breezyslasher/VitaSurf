#![no_std]
extern crate alloc;
use alloc::vec::Vec;
use alloc::boxed::Box;
use core::alloc::{GlobalAlloc, Layout};

// a bump allocator over memory.grow, as small wasm crates use
struct Bump;
static mut NEXT: usize = 0;
static mut END: usize = 0;
unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let a = l.align();
        let mut p = (NEXT + a - 1) & !(a - 1);
        if NEXT == 0 || p + l.size() > END {
            let pages = (l.size() + 65535) / 65536 + 1;
            let old = core::arch::wasm32::memory_grow(0, pages);
            if old == usize::MAX { return core::ptr::null_mut(); }
            p = old * 65536; END = p + pages * 65536;
        }
        NEXT = p + l.size();
        p as *mut u8
    }
    unsafe fn dealloc(&self, _p: *mut u8, _l: Layout) {}
}
#[global_allocator]
static A: Bump = Bump;
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }

#[link(wasm_import_module = "env")]
extern "C" { fn report(x: f64, y: i64) -> i32; }

#[no_mangle] pub extern "C" fn fib(n: u32) -> u64 { if n < 2 { n as u64 } else { fib(n - 1) + fib(n - 2) } }
#[no_mangle] pub extern "C" fn call_report(x: f64) -> i32 { unsafe { report(x * 2.0, -1234567890123) } }
#[no_mangle] pub extern "C" fn sum_squares(n: u32) -> u64 {
    let v: Vec<u64> = (0..n as u64).map(|x| x * x).collect();
    v.iter().sum()
}
#[no_mangle] pub extern "C" fn alloc_buf(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n); unsafe { v.set_len(n); }
    let b = v.into_boxed_slice(); Box::into_raw(b) as *mut u8
}
// FNV-1a over bytes the page wrote into memory
#[no_mangle] pub extern "C" fn fnv(p: *const u8, n: usize) -> u32 {
    let s = unsafe { core::slice::from_raw_parts(p, n) };
    let mut h: u32 = 0x811c9dc5; for &b in s { h ^= b as u32; h = h.wrapping_mul(0x01000193); } h
}
// memory.copy and memory.fill
#[no_mangle] pub extern "C" fn copy_fill(dst: *mut u8, src: *const u8, n: usize) {
    unsafe { core::ptr::copy(src, dst, n); core::ptr::write_bytes(dst.add(n), 0xab, 4); }
}
// indirect calls, through a table
trait Shape { fn area(&self) -> f64; }
struct Sq(f64); struct Ci(f64);
impl Shape for Sq { fn area(&self) -> f64 { self.0 * self.0 } }
impl Shape for Ci { fn area(&self) -> f64 { 3.0 * self.0 * self.0 } }
#[no_mangle] pub extern "C" fn areas(k: u32) -> f64 {
    let mut v: Vec<Box<dyn Shape>> = Vec::new();
    for i in 0..k { if i % 2 == 0 { v.push(Box::new(Sq(i as f64))) } else { v.push(Box::new(Ci(i as f64))) } }
    let ops: [fn(f64) -> f64; 2] = [|x| x + 1.0, |x| x * 2.0];
    v.iter().enumerate().map(|(i, s)| ops[i % 2](s.area())).sum()
}
#[no_mangle] pub extern "C" fn checked_div(a: i32, b: i32) -> i32 { if b == 0 { panic!() } a / b }
