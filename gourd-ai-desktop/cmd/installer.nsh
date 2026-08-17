; installer.nsh —— electron-builder NSIS 自定义脚本
;
; 目的：修复「重装桌面端后，用户配置被覆盖/清空」的问题。
;
; 背景：全局配置（.gwork/settings.json：通用设置、模型设置、会话、记忆等）按设计
; 持久化在**安装目录**内：resources/extraResources/.gwork（后端进程 cwd 与
; -Dgwork.home 均指向 extraResources，见 main/backend.js）。
; 但 assisted 安装器覆盖安装时，会先静默执行旧版卸载器，其默认逻辑是
; `RMDir /r $INSTDIR` —— 运行期产生的 .gwork 随之被整体删除，随后新文件落地
; → 用户积累的配置全部丢失。
;
; 修复策略（配置仍留在安装目录，不改变存储位置语义）：
; 1. customInit   —— 安装动作开始前，把旧安装目录的 .gwork **复制**备份到
;                     %LOCALAPPDATA% 下的暂存目录（用复制而非移动：即便用户中途
;                     取消安装，原目录配置也完好）。品牌升级前的旧版（Gourd AI 时期）
;                     全局区名为 .gourdai，此处兼容：.gwork 不存在时回退备份 .gourdai。
; 2. customInstall —— 新文件落地后，把备份还原到新安装目录的 .gwork，再清理暂存。
;                     该钩子在 uninstallOldVersion（删旧）之后执行，因此同目录覆盖、
;                     更换安装目录两种场景都能还原。
; 3. customRemoveFiles —— 卸载时，先调用位于安装目录内的 CLI 命令清理助手
;                     （.gwork\bin\desktop-cli-uninstall.ps1，兼容旧 .gourdai\bin），再删除应用文件。
;                     默认顺序是先 `RMDir /r $INSTDIR`，助手会随目录一起被删掉、
;                     导致 `gwork` 命令的 PATH 残留无法清理，故必须在删文件前执行。

!ifndef BUILD_UNINSTALLER

Var /GLOBAL cfgBackupDir

; ── 安装前：备份旧安装目录里的用户配置 ────────────────────────────────────────
!macro customInit
  ; 从注册表读取上一次安装位置（SHELL_CONTEXT 已由 initMultiUser 按安装模式设定）
  ReadRegStr $R9 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ; installMode=="all" 时，installSection 还会额外卸载 HKCU 下的旧安装
  ; （见模板 installSection.nsh），若 HKLM 无记录则回退查 HKCU，避免该场景漏备份
  ${if} $installMode == "all"
  ${andIf} $R9 == ""
    ReadRegStr $R9 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${endIf}
  StrCpy $cfgBackupDir ""
  ${if} $R9 != ""
    ; 新目录优先；品牌升级前的旧安装只有 .gourdai，回退备份之
    ${if} ${FileExists} "$R9\resources\extraResources\.gwork\*.*"
      StrCpy $cfgBackupDir "$LOCALAPPDATA\${APP_FILENAME}\config-staging"
      ; 若上次安装中断残留过暂存备份，清掉：当前存活的 .gwork 一定更新
      RMDir /r "$cfgBackupDir"
      CreateDirectory "$cfgBackupDir"
      CopyFiles /SILENT "$R9\resources\extraResources\.gwork\*.*" "$cfgBackupDir"
      DetailPrint "Backing up user config: $R9\resources\extraResources\.gwork"
    ${elseIf} ${FileExists} "$R9\resources\extraResources\.gourdai\*.*"
      StrCpy $cfgBackupDir "$LOCALAPPDATA\${APP_FILENAME}\config-staging"
      RMDir /r "$cfgBackupDir"
      CreateDirectory "$cfgBackupDir"
      CopyFiles /SILENT "$R9\resources\extraResources\.gourdai\*.*" "$cfgBackupDir"
      DetailPrint "Backing up legacy user config: $R9\resources\extraResources\.gourdai"
    ${endif}
  ${endif}
!macroend

; ── 新文件落地后：还原用户配置到新安装目录 ───────────────────────────────────
!macro customInstall
  ${if} $cfgBackupDir != ""
  ${andIf} ${FileExists} "$cfgBackupDir\*.*"
    CreateDirectory "$INSTDIR\resources\extraResources\.gwork"
    CopyFiles /SILENT "$cfgBackupDir\*.*" "$INSTDIR\resources\extraResources\.gwork"
    DetailPrint "Restored user config to: $INSTDIR\resources\extraResources\.gwork"
  ${endif}
  ; 无论是否发生还原，都清理暂存目录
  ${if} $cfgBackupDir != ""
    RMDir /r "$cfgBackupDir"
  ${endif}
!macroend

!endif ; BUILD_UNINSTALLER

; ── 卸载：先清理 `gwork` 终端命令，再删除应用文件 ─────────────────────────
; 替换默认的删文件逻辑（electron-builder 模板 uninstaller.nsh 的 else 分支），
; 在原逻辑之前插入 CLI 清理助手的调用。助手只删带 sentinel 标记的启动器；
; 若检测到 CLI 安装模式（bin 下另有 gourd-ai-agent.jar）则保留 PATH。
!macro customRemoveFiles
  IfFileExists "$INSTDIR\resources\extraResources\.gwork\bin\desktop-cli-uninstall.ps1" 0 tryLegacyCliCleanup
    DetailPrint "Removing 'gwork' terminal command..."
    nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\extraResources\.gwork\bin\desktop-cli-uninstall.ps1"'
    Goto skipCliCleanup
  tryLegacyCliCleanup:
  ; 品牌升级前的旧安装：助手在旧 .gourdai\bin 下
  IfFileExists "$INSTDIR\resources\extraResources\.gourdai\bin\desktop-cli-uninstall.ps1" 0 skipCliCleanup
    DetailPrint "Removing legacy 'gourdai' terminal command..."
    nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\extraResources\.gourdai\bin\desktop-cli-uninstall.ps1"'
  skipCliCleanup:

  ; 以下逐字复刻模板默认逻辑，保证升级/卸载行为与官方一致
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      # Attempt to restore previous directory
      Push ""
      Call un.restoreFiles
      Pop $R0

      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${endif}

  ${endif}

  # Remove all files (or remaining shallow directories from the block above)
  RMDir /r $INSTDIR
!macroend
