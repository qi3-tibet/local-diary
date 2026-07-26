!macro customInstall
  CreateShortCut "$DESKTOP\Local Diary - Browser.lnk" "$INSTDIR\Local Diary.exe" "--browser" "$INSTDIR\Local Diary.exe" 0 SW_SHOWNORMAL "" "Open Local Diary in the default browser"
  CreateShortCut "$SMPROGRAMS\Local Diary - Browser.lnk" "$INSTDIR\Local Diary.exe" "--browser" "$INSTDIR\Local Diary.exe" 0 SW_SHOWNORMAL "" "Open Local Diary in the default browser"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Local Diary - Browser.lnk"
  Delete "$SMPROGRAMS\Local Diary - Browser.lnk"
!macroend
