<p align="center">
  <img src="docs/assets/yomumi-brand.svg" alt="โลโก้และตัวอักษร Yomumi" width="256">
</p>

<h1 align="center">Yomumi Harness: ฮาร์เนสสำหรับรัน AI coding agent หลายตัวบนคอมเครื่องเดียว</h1>
<p align="center"><a href="README.md">English</a> · ภาษาไทย · <a href="README.ja.md">日本語</a></p>

Yomumi Harness คือชุดระบบที่เราใช้รัน AI coding agent หลายตัวพร้อมกันบนพีซี Windows เครื่องเดียว (Claude Code, Codex, Antigravity, Hermes และ Cursor) โดยไม่ให้แก้ไฟล์ชนกัน ไม่ใช้ token เกินงบ และไม่ปล่อยให้ agent อ้างว่า "เทสผ่าน" ทั้งที่ยังไม่ได้ตรวจจริง ในรีโปนี้มีโค้ด `yomumi-evidence` ซึ่งเป็น Rust CLI สำหรับตรวจผลเทสจาก Bun JUnit XML และสำเนาโค้ดของตัวแจกงานกับตัวส่งงานไปโมเดลฟรี ส่วนอื่นของระบบเราเขียนเป็นเอกสารภาษาอังกฤษไว้ให้คนที่อยากสร้างระบบแบบเดียวกันนำไปปรับใช้ได้

หน้านี้เป็นหน้าแนะนำแบบย่อ เอกสารฉบับเต็มเป็นภาษาอังกฤษ

## ระบบมีอะไรบ้าง

| ส่วน | ทำอะไร | อ่านต่อ (ภาษาอังกฤษ) |
| --- | --- | --- |
| แจกงาน (task dispatch) | แตกคำสั่งเดียวเป็นงานย่อย แสดงตารางงานหนัก/งานเบาให้เจ้าของดูก่อน ส่งงานเฉพาะแอปที่เปิดอยู่ ให้ agent ที่ต้องเขียนไฟล์ทำงานใน git worktree ของตัวเอง และสลับไปตัวถัดไปเมื่อโควตาหมด | [Task dispatch](docs/system/task-dispatch.md) |
| เลือกโมเดลตามความยาก | แบ่งงานเป็น search / easy / short / hard แล้วเลือกโมเดลที่ถูกที่สุดที่ทำงานนั้นได้ดี | [Model routing](docs/system/model-routing.md) |
| งบ token รายสัปดาห์ | ใช้เต็มที่จนเหลือ 5% แล้วค่อยกระจายส่วนที่เหลือให้หมดก่อนรีเซ็ตราว 10 นาที งานด่วนมาก่อนเสมอ | [Weekly token budget](docs/system/weekly-token-budget.md) |
| ส่งงานง่ายไปโมเดลฟรี | งานข้อความสาธารณะง่าย ๆ เช่นสรุปข่าวหรือแปลสั้น ๆ ส่งไปโมเดลฟรีได้ แต่ข้อความที่อ่อนไหวจะถูกปฏิเสธในเครื่องก่อนออกไปข้างนอก | [Free-tier offload](docs/system/free-tier-offload.md) |
| ช่องทางคุยระหว่าง agent | บอร์ดจองไฟล์ เธรดตามหัวข้อ และไฟล์งานในโฟลเดอร์ Markdown ที่ใช้ร่วมกัน ข้อความจาก agent ด้วยกันเป็นแค่ข้อมูล ไม่ใช่การอนุมัติ | [Agent channel](docs/system/agent-channel.md) |
| MCP gateway แบบ code mode | MCP server ในเครื่องที่มีแค่สองเครื่องมือ (`search`, `execute`) และรันโค้ดที่โมเดลเขียนใน sandbox ที่ปิดสิทธิ์ทั้งหมด | [Code-mode gateway](docs/system/code-mode-gateway.md) |
| ตรวจจากหลักฐานก่อนเสมอ | "ยังไม่ได้ตรวจ" ห้ามกลายเป็น "ผ่าน" ส่วนนี้คือ CLI ในรีโปนี้ | [Evidence-first verification](docs/system/evidence-first-verification.md) |
| ไม่ให้เครื่องหน่วง / กู้งานหลังเครื่องล่ม | เซิร์ฟเวอร์ละตัว เบราว์เซอร์ headless ละตัว build ทีละงาน commit งานค้างไว้ใน branch | [Machine load](docs/system/machine-load.md) · [Crash recovery](docs/system/crash-recovery.md) |

ภาพรวมทั้งหมดและแผนผังอยู่ที่ [docs/system/README.md](docs/system/README.md) มี [คำศัพท์](docs/system/glossary.md) [คำถามที่พบบ่อย](docs/system/faq.md) และ [เทียบกับเครื่องมือประเภทอื่น](docs/system/comparison.md) ด้วย

## ลองใช้ CLI

ต้องมี [Rust](https://www.rust-lang.org/tools/install) ในเครื่อง คำสั่งนี้ใช้รายงานตัวอย่างที่อยู่ในรีโปอยู่แล้ว ไม่ต้องมี Bun

~~~sh
git clone https://github.com/Lumichandesu/yomumi-harness.git
cd yomumi-harness
cargo run --release --locked -- compare examples/replay/before.xml examples/replay/after.xml --before-exit 1 --after-exit 0
~~~

ผลที่ควรได้คือ `matched` มีเทส 2 ตัว และแก้ได้ 1 ตัว (`fixed`) รายละเอียดการติดตั้งและการใช้กับโปรเจกต์จริงอยู่ใน [README ภาษาอังกฤษ](README.md)

## ขอบเขตและความเป็นส่วนตัว

รีโปนี้เป็นส่วนที่แชร์ได้ของ Yomumi ไม่ใช่ตัวผลิตภัณฑ์ ซอร์สโค้ดของตัวแจกงานและตัวส่งงานไปโมเดลฟรีเปิดเป็นฉบับสำเนา (ณ วันที่ 27 พ.ย. 2026 ตัดข้อมูลเฉพาะเครื่องออกแล้ว) อยู่ในโฟลเดอร์ [harness/](harness/README.md) ส่วน gateway ยังเป็นโค้ดส่วนตัว สัญญาอนุญาต [MIT](LICENSE)
