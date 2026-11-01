Attribute VB_Name = "CsvAggregator"
' CSV 集計ツール（Excel VBA）
'
' フォルダ内の CSV をすべて読み、「年月 x 商品」の集計表を新しいブックに作る。
' 元の CSV は読むだけで書き換えない。結果のブックは保存しない（保存するかは使う人が決める）。
'
' 【注意】このファイル（src/）は UTF-8 で管理している。Excel に取り込むときは
'         dist/CsvAggregator.bas（npm run build で作る Shift_JIS 版）を使うこと。
'
' 集計のルールは src/lib.js（参照実装）と同じ。Private 関数の名前と手順も合わせている。
' マクロの一覧に出すのは SetupSettings と RunAggregation の 2 つだけ。
Option Explicit

Private Const ENCODING_AUTO As String = "自動"
Private Const ENCODING_UTF8_BOM As String = "UTF-8（BOM あり）"
Private Const ENCODING_UTF8 As String = "UTF-8"
Private Const ENCODING_SJIS As String = "Shift_JIS"
Private Const ENCODING_UTF16 As String = "UTF-16"
Private Const MAX_DETAIL_ROWS As Long = 1048575  ' シートの上限 1,048,576 行 - 見出し 1 行
Private Const SHEET_SETTINGS As String = "設定"
Private Const UNCLOSED_QUOTE_MESSAGE As String = "引用符（""）が閉じていません。この行で始まった引用符がファイルの終わりまで続いているため、後ろの行を読めません"
Private Const UTF16_MESSAGE As String = "UTF-16 には対応していません。UTF-8 か Shift_JIS で保存し直してください"
' 迷子の引用符（仕様 5.5）。{…} を QuoteTailMessage・QuoteCommaMessage で置き換える。波ダッシュは使わない（Shift_JIS 変換で文字が変わるため）
Private Const QUOTE_TAIL_MESSAGE As String = "{startLine} 行目の「{column}」で始まった引用符（""）が {endLine} 行目で閉じたあと、すぐ後ろに文字が続いています。{startLine} 行目から {endLine} 行目までが 1 つの値として読まれ、行が消えている可能性があります。{startLine} 行目と {endLine} 行目に余分な "" がないか確かめてください（値の中に "" を書くときは """" と 2 つ重ねます）"
Private Const QUOTE_COMMA_MESSAGE As String = "{startLine} 行目の「{column}」で始まった引用符（""）の中に、改行が {newlines} 個とカンマが {commas} 個あり、1 行分以上のデータが入っているように見えます。{startLine} 行目から {endLine} 行目までが 1 つの値として読まれ、行が消えている可能性があります。{startLine} 行目と {endLine} 行目に余分な "" がないか確かめてください。値の中に本当にカンマの多い複数行の文がある場合は、「設定」シートの QUOTE_CHECK を FALSE にしてください"

' 明細 1 行の配列の位置
Private Const R_YM As Long = 0
Private Const R_YMD As Long = 1
Private Const R_ORDER As Long = 2
Private Const R_PRODUCT As Long = 3
Private Const R_QTY As Long = 4
Private Const R_AMOUNT As Long = 5
Private Const R_FILE As Long = 6
Private Const R_LINE As Long = 7

' ======================================================================
' マクロ（Public）
' ======================================================================

' 「設定」シートを作る。既にあるキーの値は上書きしない（何度実行してもよい）。
Public Sub SetupSettings()
    Dim ws As Worksheet
    Dim defaults As Variant
    Dim i As Long
    Dim r As Long
    Dim key As String

    Set ws = GetOrCreateSheet(ThisWorkbook, SHEET_SETTINGS)
    ws.Range("A1:C1").Value = Array("キー", "値", "説明")
    StyleHeader ws.Range("A1:C1")

    defaults = DefaultSettings()
    For i = LBound(defaults) To UBound(defaults)
        key = defaults(i)(0)
        r = FindKeyRow(ws, key)
        If r = 0 Then
            r = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row + 1
            ws.Cells(r, 1).Value = key
            ws.Cells(r, 2).NumberFormat = "@"
            ws.Cells(r, 2).Value = defaults(i)(1)
            ws.Cells(r, 3).Value = defaults(i)(2)
        End If
        ws.Cells(r, 2).Interior.Color = RGB(255, 248, 197)  ' 入力セル #fff8c5
        If key = "ENCODING" Then SetDropDown ws.Cells(r, 2), ENCODING_AUTO & "," & ENCODING_UTF8 & "," & ENCODING_SJIS
        If key = "DEDUPE" Or key = "QUOTE_CHECK" Then SetDropDown ws.Cells(r, 2), "TRUE,FALSE"
    Next i

    ws.Columns("A:A").ColumnWidth = 16
    ws.Columns("B:B").ColumnWidth = 40
    ws.Columns("C:C").ColumnWidth = 70
    ws.Activate
    FreezeHeaderRow
    MsgBox "「設定」シートを用意しました。黄色のセルを確認してから、マクロ RunAggregation を実行してください。", vbInformation
End Sub

' フォルダ内の CSV を集計し、新しいブックに出力する。
Public Sub RunAggregation()
    Dim settings As Object
    Dim colNames As Object
    Dim fso As Object
    Dim outWb As Workbook
    Dim names As Variant
    Dim folder As String
    Dim msg As String
    Dim allRows As Collection
    Dim errors As Collection
    Dim reports As Collection
    Dim details As Collection
    Dim removedByFile As Object
    Dim i As Long
    Dim bytes() As Byte
    Dim readError As String
    Dim enc As String
    Dim text As String
    Dim dataRows As Long
    Dim usedRows As Long
    Dim removedTotal As Long
    Dim rep As Variant

    On Error GoTo Failed

    If Not SheetExists(ThisWorkbook, SHEET_SETTINGS) Then
        MsgBox "「設定」シートがありません。先にマクロ SetupSettings を実行してください。", vbExclamation
        Exit Sub
    End If
    Set settings = ReadSettings()
    msg = ValidateSettings(settings)
    If msg <> "" Then
        MsgBox msg, vbExclamation
        Exit Sub
    End If

    folder = CleanFolderPath(settings("CSV_FOLDER"))
    If folder = "" Then folder = PickFolder()
    If folder = "" Then Exit Sub  ' フォルダの選択をやめた
    Set fso = CreateObject("Scripting.FileSystemObject")
    If Not fso.FolderExists(folder) Then
        MsgBox "フォルダが見つかりません: " & folder, vbExclamation
        Exit Sub
    End If
    names = ListCsvFiles(FolderFileNames(fso, folder))
    If UBound(names) < LBound(names) Then
        MsgBox "フォルダに CSV ファイルがありません: " & folder, vbExclamation
        Exit Sub
    End If

    Set colNames = CreateObject("Scripting.Dictionary")
    colNames("date") = settings("COL_DATE")
    colNames("product") = settings("COL_PRODUCT")
    colNames("quantity") = settings("COL_QUANTITY")
    colNames("amount") = settings("COL_AMOUNT")
    colNames("orderId") = settings("COL_ORDER_ID")

    Application.ScreenUpdating = False
    Set allRows = New Collection
    Set errors = New Collection
    Set reports = New Collection

    For i = LBound(names) To UBound(names)
        readError = ReadBytes(fso.BuildPath(folder, names(i)), bytes)
        If readError <> "" Then
            errors.Add Array(names(i), 0, "ファイルを読めません（他のアプリで開いていないか確認してください）: " & readError)
            reports.Add Array(names(i), "-", 0, 0, 0)
        ElseIf HasUtf16Bom(bytes) Then
            errors.Add Array(names(i), 1, UTF16_MESSAGE)
            reports.Add Array(names(i), ENCODING_UTF16, 0, 0, 0)
        Else
            If settings("ENCODING") = ENCODING_UTF8 Then
                enc = ENCODING_UTF8
            ElseIf settings("ENCODING") = ENCODING_SJIS Then
                enc = ENCODING_SJIS
            Else
                enc = DetectEncoding(bytes)
            End If
            If enc = ENCODING_SJIS Then
                text = StripBom(DecodeBytes(bytes, "shift_jis"))
            Else
                text = StripBom(DecodeBytes(bytes, "utf-8"))
            End If
            NormalizeRows CStr(names(i)), ParseCsv(text), colNames, settings("QUOTE_CHECK") = "TRUE", allRows, errors, dataRows, usedRows
            reports.Add Array(names(i), enc, dataRows, usedRows, 0)
        End If
    Next i

    Set removedByFile = CreateObject("Scripting.Dictionary")
    If settings("DEDUPE") = "TRUE" Then
        Set details = DedupeRecords(allRows, removedByFile)
        Set reports = ApplyRemovedCounts(reports, removedByFile)
    Else
        Set details = allRows
    End If

    If details.Count > MAX_DETAIL_ROWS Then
        errors.Add Array("（全体）", 0, "明細が " & details.Count & " 行あり、シートの上限（" & MAX_DETAIL_ROWS & " 行）を超えています")
    End If

    If errors.Count > 0 Then
        Set outWb = Workbooks.Add(xlWBATWorksheet)
        WriteErrors outWb.Worksheets(1), errors
        Application.ScreenUpdating = True
        MsgBox "入力に不備が " & errors.Count & " 件あったため、集計は作りませんでした。" & vbCrLf & _
               "新しいブックの「エラー」シートで、ファイル名と行番号を確認してください。", vbExclamation
        Exit Sub
    End If

    ' どの CSV も見出しだけ（データ 0 行）なら、空の集計は作らずに知らせる
    If details.Count = 0 Then
        Application.ScreenUpdating = True
        MsgBox "CSV にデータの行がありませんでした（見出しだけでした）。集計は作りませんでした。" & vbCrLf & _
               "フォルダと CSV の中身を確認してください: " & folder, vbExclamation
        Exit Sub
    End If

    Set outWb = Workbooks.Add(xlWBATWorksheet)
    WriteSummary outWb.Worksheets(1), AggregateByMonthProduct(details)
    WriteMonthly outWb.Worksheets.Add(After:=outWb.Worksheets(outWb.Worksheets.Count)), AggregateByMonth(details)
    WriteDetails outWb.Worksheets.Add(After:=outWb.Worksheets(outWb.Worksheets.Count)), details
    WriteReports outWb.Worksheets.Add(After:=outWb.Worksheets(outWb.Worksheets.Count)), reports, folder
    outWb.Worksheets(1).Activate

    For Each rep In reports
        removedTotal = removedTotal + rep(4)
    Next rep
    Application.ScreenUpdating = True
    MsgBox "集計しました。CSV " & (UBound(names) - LBound(names) + 1) & " 件、明細 " & details.Count & " 行" & _
           "（重複で除いた行 " & removedTotal & "）。" & vbCrLf & _
           "新しいブックはまだ保存されていません。必要なら名前を付けて保存してください。", vbInformation
    Exit Sub

Failed:
    msg = "想定外のエラーで止まりました（" & Err.Number & "）: " & Err.Description
    On Error Resume Next
    Application.ScreenUpdating = True
    If Not outWb Is Nothing Then
        outWb.Close SaveChanges:=False
        msg = msg & vbCrLf & "作りかけのブックは保存せずに閉じました。"
    End If
    MsgBox msg & vbCrLf & "元の CSV は変更していません。", vbCritical
End Sub

' ======================================================================
' 参照実装（src/lib.js）と同じ処理
' ======================================================================

' UTF-8 として正しいバイト列か（RFC 3629。過長表現・サロゲート・途中で切れたものは不正）
Private Function IsValidUtf8(bytes() As Byte) As Boolean
    Dim i As Long
    Dim n As Long
    Dim b As Long
    Dim c As Long
    Dim need As Long
    Dim minCp As Long
    Dim cp As Long
    Dim k As Long

    i = LBound(bytes)
    n = UBound(bytes)  ' 最後の位置（空の配列なら -1）
    Do While i <= n
        b = bytes(i)
        If b < &H80& Then
            i = i + 1
        Else
            If b >= &HC2& And b <= &HDF& Then
                need = 1: minCp = &H80&: cp = b And &H1F&
            ElseIf b >= &HE0& And b <= &HEF& Then
                need = 2: minCp = &H800&: cp = b And &HF&
            ElseIf b >= &HF0& And b <= &HF4& Then
                need = 3: minCp = &H10000: cp = b And &H7&
            Else
                Exit Function
            End If
            If i + need > n Then Exit Function  ' 途中で切れている
            For k = 1 To need
                c = bytes(i + k)
                If (c And &HC0&) <> &H80& Then Exit Function
                cp = cp * 64 + (c And &H3F&)
            Next k
            If cp < minCp Or cp > &H10FFFF Or (cp >= &HD800& And cp <= &HDFFF&) Then Exit Function
            i = i + need + 1
        End If
    Loop
    IsValidUtf8 = True
End Function

' 先頭が UTF-16 の BOM（FF FE か FE FF）か。UTF-16 のファイルは読まずにエラーにする
Private Function HasUtf16Bom(bytes() As Byte) As Boolean
    If UBound(bytes) - LBound(bytes) < 1 Then Exit Function
    If bytes(LBound(bytes)) = &HFF& And bytes(LBound(bytes) + 1) = &HFE& Then HasUtf16Bom = True
    If bytes(LBound(bytes)) = &HFE& And bytes(LBound(bytes) + 1) = &HFF& Then HasUtf16Bom = True
End Function

' 文字コードの判定: BOM → UTF-8 として正しいか → Shift_JIS
Private Function DetectEncoding(bytes() As Byte) As String
    If UBound(bytes) - LBound(bytes) >= 2 Then
        If bytes(LBound(bytes)) = &HEF& And bytes(LBound(bytes) + 1) = &HBB& And bytes(LBound(bytes) + 2) = &HBF& Then
            DetectEncoding = ENCODING_UTF8_BOM
            Exit Function
        End If
    End If
    If IsValidUtf8(bytes) Then
        DetectEncoding = ENCODING_UTF8
    Else
        DetectEncoding = ENCODING_SJIS
    End If
End Function

' 先頭の BOM（U+FEFF）を 1 文字だけ取り除く
Private Function StripBom(ByVal text As String) As String
    If Len(text) > 0 Then
        If CodeUnit(Left$(text, 1)) = &HFEFF& Then
            StripBom = Mid$(text, 2)
            Exit Function
        End If
    End If
    StripBom = text
End Function

' CSV を分解する。戻り値は Collection。各要素は Array(行番号, 項目の配列, 閉じていない引用符の行,
' 判定 A の引用符が始まった行, 判定 A の閉じた行, 判定 A の列（0 から）)。判定 A に当たらなければ 4 つめから 6 つめは 0, 0, -1。
' 改行は CRLF・LF・CR のどれでもよい。引用符の中のカンマ・改行・"" を扱う。
' 引用符の中の改行は LF（vbLf）にそろえて値に残す（ファイルの改行コードが違っても同じ値になるように）。
' 行番号は、そのレコードが始まる物理的な行（1 から）。
' 引用符が閉じないままファイルが終わったときは、最後のレコードの 3 つめに引用符が始まった行を入れる（それ以外は 0）。
' 判定 A（仕様 5.5）: 改行を含む引用符の値で、閉じた " の後ろ（空白は読み飛ばす）が , ・改行・ファイルの終わり以外なら印を付ける
' （1 レコードで最初の 1 つだけ）。読み方そのものは変えない。
Private Function ParseCsv(ByVal text As String) As Collection
    Dim records As Collection
    Dim fields As Collection
    Dim field As String
    Dim ch As String
    Dim nextCh As String
    Dim inQuotes As Boolean
    Dim atFieldStart As Boolean
    Dim hasContent As Boolean
    Dim i As Long
    Dim n As Long
    Dim lineNo As Long
    Dim startLine As Long
    Dim quoteLine As Long
    Dim unclosedLine As Long
    Dim quoteHasNewline As Boolean
    Dim tailStartLine As Long
    Dim tailEndLine As Long
    Dim tailField As Long

    Set records = New Collection
    Set fields = New Collection
    n = Len(text)
    i = 1
    lineNo = 1
    startLine = 1
    atFieldStart = True
    tailField = -1

    Do While i <= n
        ch = Mid$(text, i, 1)
        If i < n Then nextCh = Mid$(text, i + 1, 1) Else nextCh = ""
        If inQuotes Then
            If ch = """" Then
                If nextCh = """" Then
                    field = field & """"
                    i = i + 2
                Else
                    inQuotes = False
                    If quoteHasNewline And tailField < 0 Then
                        If Not IsQuoteEnd(text, i + 1) Then
                            tailStartLine = quoteLine
                            tailEndLine = lineNo
                            tailField = fields.Count
                        End If
                    End If
                    i = i + 1
                End If
            ElseIf ch = vbCr Or ch = vbLf Then
                If ch = vbCr And nextCh = vbLf Then
                    i = i + 2
                Else
                    i = i + 1
                End If
                field = field & vbLf
                lineNo = lineNo + 1
                quoteHasNewline = True
            Else
                field = field & ch
                i = i + 1
            End If
        ElseIf ch = """" And atFieldStart Then
            inQuotes = True
            quoteLine = lineNo
            quoteHasNewline = False
            atFieldStart = False
            hasContent = True
            i = i + 1
        ElseIf ch = "," Then
            fields.Add field
            field = ""
            atFieldStart = True
            hasContent = True
            i = i + 1
        ElseIf ch = vbCr Or ch = vbLf Then
            If ch = vbCr And nextCh = vbLf Then
                i = i + 2
            Else
                i = i + 1
            End If
            fields.Add field
            records.Add Array(startLine, CollectionToArray(fields), 0, tailStartLine, tailEndLine, tailField)
            tailStartLine = 0
            tailEndLine = 0
            tailField = -1
            Set fields = New Collection
            field = ""
            atFieldStart = True
            hasContent = False
            lineNo = lineNo + 1
            startLine = lineNo
        Else
            field = field & ch
            atFieldStart = False
            hasContent = True
            i = i + 1
        End If
    Loop
    If hasContent Or fields.Count > 0 Or field <> "" Then
        If inQuotes Then unclosedLine = quoteLine
        fields.Add field
        records.Add Array(startLine, CollectionToArray(fields), unclosedLine, tailStartLine, tailEndLine, tailField)
    End If
    Set ParseCsv = records
End Function

' 閉じた引用符の後ろ（pos 文字目から）が、空白を読み飛ばして , ・CR・LF・ファイルの終わりのどれかか
' （text は大きいので ByRef で受け取り、写しを作らない）
Private Function IsQuoteEnd(ByRef text As String, ByVal pos As Long) As Boolean
    Dim j As Long
    Dim c As String
    j = pos
    Do While j <= Len(text)
        If Not IsSpaceChar(Mid$(text, j, 1)) Then Exit Do
        j = j + 1
    Loop
    If j > Len(text) Then
        IsQuoteEnd = True
    Else
        c = Mid$(text, j, 1)
        IsQuoteEnd = (c = "," Or c = vbCr Or c = vbLf)
    End If
End Function

' 判定 A のエラー文。列名は最後に置き換える（列名の中の { } を置き換えないように）
Private Function QuoteTailMessage(ByVal startLine As Long, ByVal endLine As Long, ByVal column As String) As String
    Dim s As String
    s = Replace(QUOTE_TAIL_MESSAGE, "{startLine}", CStr(startLine))
    s = Replace(s, "{endLine}", CStr(endLine))
    QuoteTailMessage = Replace(s, "{column}", column)
End Function

' 判定 B のエラー文
Private Function QuoteCommaMessage(ByVal startLine As Long, ByVal endLine As Long, ByVal column As String, _
                                   ByVal newlines As Long, ByVal commas As Long) As String
    Dim s As String
    s = Replace(QUOTE_COMMA_MESSAGE, "{startLine}", CStr(startLine))
    s = Replace(s, "{endLine}", CStr(endLine))
    s = Replace(s, "{newlines}", CStr(newlines))
    s = Replace(s, "{commas}", CStr(commas))
    QuoteCommaMessage = Replace(s, "{column}", column)
End Function

' エラー文に出す列名。見出しの値の最初の改行より前を TrimText したもの。見出しより右か、空なら「N 列目」（N は 1 から）
' 改行より前だけにするのは、見出しの行で引用符が始まったとき、見出しの値に後ろの行が吸い込まれているため。
Private Function QuoteColumnName(headerFields As Variant, ByVal field As Long) As String
    Dim name As String
    Dim cellText As String
    Dim pos As Long
    If field <= UBound(headerFields) - LBound(headerFields) Then
        cellText = CStr(headerFields(LBound(headerFields) + field))
        pos = InStr(cellText, vbLf)
        If pos > 0 Then cellText = Left$(cellText, pos - 1)
        name = TrimText(cellText)
    End If
    If name = "" Then name = CStr(field + 1) & " 列目"
    QuoteColumnName = name
End Function

' 判定 B: 改行を含む値の中のカンマの合計が「見出しの列数 - 1」以上なら、一番左の 1 つでエラーを足して True を返す。
' 行番号は元のファイルの行に戻す（その値より前の列の改行の数を足す）。
Private Function CheckQuoteCommas(ByVal fileName As String, rec As Variant, headerFields As Variant, errors As Collection) As Boolean
    Dim fields As Variant
    Dim k As Long
    Dim cellText As String
    Dim newlines As Long
    Dim commas As Long
    Dim newlinesBefore As Long
    Dim headerCount As Long
    Dim startLine As Long

    fields = rec(1)
    headerCount = UBound(headerFields) - LBound(headerFields) + 1
    For k = 0 To UBound(fields) - LBound(fields)
        cellText = CStr(fields(LBound(fields) + k))
        newlines = CountChar(cellText, vbLf)
        If newlines > 0 Then
            commas = CountChar(cellText, ",")
            If commas >= headerCount - 1 Then
                startLine = rec(0) + newlinesBefore
                errors.Add Array(fileName, startLine, _
                                 QuoteCommaMessage(startLine, startLine + newlines, QuoteColumnName(headerFields, k), newlines, commas))
                CheckQuoteCommas = True
                Exit Function
            End If
        End If
        newlinesBefore = newlinesBefore + newlines
    Next k
End Function

' 設定の CSV_FOLDER を整える。前後の空白を除き、全体が "…" で囲まれていれば外側の引用符を除く
' （Windows の「パスのコピー」は引用符つきでコピーされるため）
Private Function CleanFolderPath(ByVal s As String) As String
    Dim t As String
    t = TrimText(s)
    If Len(t) >= 2 Then
        If Left$(t, 1) = """" And Right$(t, 1) = """" Then t = TrimText(Mid$(t, 2, Len(t) - 2))
    End If
    CleanFolderPath = t
End Function

' 前後の半角スペース・タブ・全角スペースを除く
Private Function TrimText(ByVal s As String) As String
    Dim startPos As Long
    Dim endPos As Long
    startPos = 1
    endPos = Len(s)
    Do While startPos <= endPos
        If Not IsSpaceChar(Mid$(s, startPos, 1)) Then Exit Do
        startPos = startPos + 1
    Loop
    Do While endPos >= startPos
        If Not IsSpaceChar(Mid$(s, endPos, 1)) Then Exit Do
        endPos = endPos - 1
    Loop
    TrimText = Mid$(s, startPos, endPos - startPos + 1)
End Function

' 数量・金額を数値にする。読めなければ False を返す
Private Function ParseNumber(ByVal s As String, ByRef result As Double) As Boolean
    Dim t As String
    Dim removed As String
    Dim skipChars As String
    Dim i As Long
    Dim c As String

    ' カンマ・全角カンマ・円記号（半角 U+00A5、全角）・バックスラッシュ・「円」・空白
    skipChars = "," & ChrW(&HFF0C&) & ChrW(&HA5&) & ChrW(&HFFE5&) & "\" & ChrW(&H5186&) & " " & vbTab & ChrW(&H3000&)
    t = ToHalfWidthDigits(TrimText(s))
    For i = 1 To Len(t)
        c = Mid$(t, i, 1)
        If InStr(1, skipChars, c, vbBinaryCompare) = 0 Then removed = removed & c
    Next i
    If Not IsNumberText(removed) Then Exit Function
    result = Val(removed)  ' Val は地域設定に関係なく "." を小数点として読む
    ParseNumber = True
End Function

' 日付を ymd（YYYY-MM-DD）と ym（YYYY-MM）にする。読めなければ False を返す
Private Function ParseDate(ByVal s As String, ByRef ymd As String, ByRef ym As String) As Boolean
    Dim t As String
    Dim cut As Long
    Dim p As Long
    Dim parts As Variant
    Dim y As Long
    Dim m As Long
    Dim d As Long

    t = ToHalfWidthDigits(TrimText(s))
    cut = Len(t) + 1
    p = InStr(1, t, " ", vbBinaryCompare)
    If p > 0 And p < cut Then cut = p
    p = InStr(1, t, "T", vbBinaryCompare)
    If p > 0 And p < cut Then cut = p
    t = Left$(t, cut - 1)
    t = Replace(t, "年", "/")
    t = Replace(t, "月", "/")
    t = Replace(t, "日", "")

    If Len(t) = 8 And IsDigits(t) Then
        y = CLng(Left$(t, 4))
        m = CLng(Mid$(t, 5, 2))
        d = CLng(Mid$(t, 7, 2))
    Else
        parts = Split(Replace(t, "-", "/"), "/")
        If UBound(parts) <> 2 Then Exit Function
        If Len(parts(0)) <> 4 Or Not IsDigits(CStr(parts(0))) Then Exit Function
        If Len(parts(1)) < 1 Or Len(parts(1)) > 2 Or Not IsDigits(CStr(parts(1))) Then Exit Function
        If Len(parts(2)) < 1 Or Len(parts(2)) > 2 Or Not IsDigits(CStr(parts(2))) Then Exit Function
        y = CLng(parts(0))
        m = CLng(parts(1))
        d = CLng(parts(2))
    End If
    If y < 1900 Or y > 9999 Or m < 1 Or m > 12 Then Exit Function
    If d < 1 Or d > DaysInMonth(y, m) Then Exit Function
    ym = y & "-" & Right$("0" & m, 2)
    ymd = ym & "-" & Right$("0" & d, 2)
    ParseDate = True
End Function

' 見出しから列の位置（0 から）を探す。戻り値は Array(日付, 商品, 数量, 金額, 注文番号)。なければ -1。
' 見つからない必須の見出し名は missing に入れる。
Private Function FindColumns(header As Variant, colNames As Object, missing As Collection) As Variant
    Dim keys As Variant
    Dim result(4) As Long
    Dim k As Long
    Dim i As Long
    Dim name As String

    keys = Array("date", "product", "quantity", "amount", "orderId")
    For k = 0 To 4
        name = colNames(keys(k))
        result(k) = -1
        If name <> "" Then
            For i = LBound(header) To UBound(header)
                If TrimText(StripBom(CStr(header(i)))) = name Then
                    result(k) = i - LBound(header)
                    Exit For
                End If
            Next i
            If result(k) = -1 Then missing.Add name
        End If
    Next k
    FindColumns = result
End Function

' 1 ファイル分のレコードを明細にそろえる。明細は outRows に、不備は errors に追加する。
' quoteCheck: 判定 B（仕様 5.5）を行うか。
' 閉じていない引用符・判定 A・判定 B のどれかに当たったデータのレコードは、引用符のエラーを 1 件だけ出し、
' 日付・商品・数量・金額のエラーは出さない（データ行には数える）。
' 見出しのレコードで判定 A・B に当たったら、そのエラーだけを出し、列は探さない（データ行は 0）。
' このファイルのエラーは、最後に行番号の順に並べる（SortErrorsByLine）。
Private Sub NormalizeRows(ByVal fileName As String, records As Collection, colNames As Object, ByVal quoteCheck As Boolean, _
                          outRows As Collection, errors As Collection, ByRef dataRows As Long, ByRef usedRows As Long)
    Dim rec As Variant
    Dim fields As Variant
    Dim cols As Variant
    Dim missing As Collection
    Dim name As Variant
    Dim headerFound As Boolean
    Dim errorCount As Long
    Dim rawValue As String
    Dim ymd As String
    Dim ym As String
    Dim product As String
    Dim quantity As Double
    Dim amount As Double
    Dim orderId As String
    Dim lineNo As Long
    Dim lastRec As Variant
    Dim headerFields As Variant
    Dim quoteError As Boolean
    Dim firstError As Long

    dataRows = 0
    usedRows = 0
    firstError = errors.Count + 1
    ' 閉じていない引用符があると、そこから後ろの行が 1 つの値に吸い込まれる。黙って行が消えないよう、先にエラーにする
    If records.Count > 0 Then
        lastRec = records(records.Count)
        If lastRec(2) > 0 Then errors.Add Array(fileName, lastRec(2), UNCLOSED_QUOTE_MESSAGE)
    End If
    For Each rec In records
        fields = rec(1)
        lineNo = rec(0)
        If Not IsBlankRecord(fields) Then
            If Not headerFound Then
                headerFound = True
                headerFields = fields
                ' 見出しのレコードも判定 A・B の対象にする（audit 3 回目 必須 1）。当たったら見出しが崩れているので、列は探さずに終える。
                ' 見出しの閉じていない引用符は上で出しているので、今までどおり列を探す
                If rec(2) = 0 Then
                    If rec(5) >= 0 Then
                        errors.Add Array(fileName, rec(3), QuoteTailMessage(rec(3), rec(4), QuoteColumnName(headerFields, rec(5))))
                        quoteError = True
                    ElseIf quoteCheck Then
                        quoteError = CheckQuoteCommas(fileName, rec, headerFields, errors)
                    End If
                    If quoteError Then
                        SortErrorsByLine errors, firstError
                        Exit Sub
                    End If
                End If
                Set missing = New Collection
                cols = FindColumns(fields, colNames, missing)
                If missing.Count > 0 Then
                    For Each name In missing
                        If name = colNames("orderId") Then
                            errors.Add Array(fileName, lineNo, "必要な列「" & name & "」が見出しにありません" & _
                                             "（注文番号の列がない CSV なら、設定の COL_ORDER_ID を空にしてください）")
                        Else
                            errors.Add Array(fileName, lineNo, "必要な列「" & name & "」が見出しにありません")
                        End If
                    Next name
                    SortErrorsByLine errors, firstError
                    Exit Sub
                End If
            Else
                dataRows = dataRows + 1
                ' 引用符のエラー（優先順: 閉じていない引用符 → 判定 A → 判定 B）。閉じていない引用符のエラーは上で出している
                quoteError = (rec(2) > 0)
                If Not quoteError And rec(5) >= 0 Then
                    errors.Add Array(fileName, rec(3), QuoteTailMessage(rec(3), rec(4), QuoteColumnName(headerFields, rec(5))))
                    quoteError = True
                End If
                If Not quoteError And quoteCheck Then quoteError = CheckQuoteCommas(fileName, rec, headerFields, errors)
                If Not quoteError Then
                    errorCount = errors.Count

                    rawValue = FieldAt(fields, cols(0))
                    If Not ParseDate(rawValue, ymd, ym) Then
                        If TrimText(rawValue) = "" Then
                            errors.Add Array(fileName, lineNo, "「" & colNames("date") & "」が空です")
                        Else
                            errors.Add Array(fileName, lineNo, "「" & colNames("date") & "」を日付として読めません: " & TrimText(rawValue))
                        End If
                    End If
                    product = TrimText(FieldAt(fields, cols(1)))
                    If product = "" Then
                        errors.Add Array(fileName, lineNo, "「" & colNames("product") & "」が空です")
                    End If
                    rawValue = FieldAt(fields, cols(2))
                    If Not ParseNumber(rawValue, quantity) Then
                        errors.Add Array(fileName, lineNo, NumberError(colNames("quantity"), rawValue))
                    End If
                    rawValue = FieldAt(fields, cols(3))
                    If Not ParseNumber(rawValue, amount) Then
                        errors.Add Array(fileName, lineNo, NumberError(colNames("amount"), rawValue))
                    End If

                    If errors.Count = errorCount Then
                        orderId = ""
                        If cols(4) >= 0 Then orderId = TrimText(FieldAt(fields, cols(4)))
                        outRows.Add Array(ym, ymd, orderId, product, quantity, amount, fileName, lineNo)
                        usedRows = usedRows + 1
                    End If
                End If
            End If
        End If
    Next rec
    If Not headerFound Then errors.Add Array(fileName, 1, "見出しの行がありません（空のファイル）")
    SortErrorsByLine errors, firstError
End Sub

' errors の firstIndex 番目から後ろ（1 ファイル分のエラー）を行番号の順に並べる（テスト 3 回目 気づいたこと 1）。
' 同じ行のエラーは足した順のまま（挿入ソートで安定）。閉じていない引用符のエラーは、後ろの行のものでも先に足しているため。
Private Sub SortErrorsByLine(errors As Collection, ByVal firstIndex As Long)
    Dim list() As Variant
    Dim entry As Variant
    Dim n As Long
    Dim k As Long
    Dim j As Long
    Dim moved As Boolean

    n = errors.Count - firstIndex + 1
    If n < 2 Then Exit Sub
    ReDim list(1 To n)
    For k = 1 To n
        list(k) = errors(firstIndex + k - 1)
    Next k
    For k = 2 To n
        entry = list(k)
        j = k - 1
        Do While j >= 1
            If list(j)(1) <= entry(1) Then Exit Do
            list(j + 1) = list(j)
            j = j - 1
            moved = True
        Loop
        list(j + 1) = entry
    Next k
    If Not moved Then Exit Sub  ' もう行の順なら、入れ直さない
    For k = 1 To n
        errors.Remove firstIndex
    Next k
    For k = 1 To n
        errors.Add list(k)
    Next k
End Sub

' 重複の削除。inRows はファイル名の昇順・行の順に並んでいること。
' 同じキーの行が複数のファイルにあるときは、ファイルごとの件数のうち最大の数だけ残す。
' 除いた行数をファイルごとに removedByFile（Dictionary）に入れる。
Private Function DedupeRecords(inRows As Collection, removedByFile As Object) As Collection
    Dim kept As Object
    Dim inFile As Object
    Dim out As Collection
    Dim r As Variant
    Dim key As String
    Dim currentFile As String
    Dim first As Boolean

    Set kept = CreateObject("Scripting.Dictionary")
    Set inFile = CreateObject("Scripting.Dictionary")
    Set out = New Collection
    first = True
    For Each r In inRows
        If first Or r(R_FILE) <> currentFile Then
            currentFile = r(R_FILE)
            inFile.RemoveAll
            first = False
        End If
        key = r(R_YMD) & ChrW(1) & r(R_ORDER) & ChrW(1) & r(R_PRODUCT) & ChrW(1) & CStr(r(R_QTY)) & ChrW(1) & CStr(r(R_AMOUNT))
        inFile(key) = inFile(key) + 1
        If inFile(key) > kept(key) Then
            kept(key) = inFile(key)
            out.Add r
        Else
            removedByFile(r(R_FILE)) = removedByFile(r(R_FILE)) + 1
        End If
    Next r
    Set DedupeRecords = out
End Function

' 「年月 x 商品」で集計。戻り値は Array(年月, 商品, 数量, 金額) の配列。
' 並び順: 年月の昇順 → 金額の降順 → 商品名（文字コード順）
Private Function AggregateByMonthProduct(inRows As Collection) As Variant
    Dim index As Object
    Dim list() As Variant
    Dim count As Long
    Dim r As Variant
    Dim key As String
    Dim item As Variant
    Dim pos As Long

    Set index = CreateObject("Scripting.Dictionary")
    ReDim list(0 To 0)
    For Each r In inRows
        key = r(R_YM) & ChrW(1) & r(R_PRODUCT)
        If Not index.Exists(key) Then
            If count > UBound(list) Then ReDim Preserve list(0 To count * 2)
            list(count) = Array(r(R_YM), r(R_PRODUCT), 0#, 0#)
            index(key) = count
            count = count + 1
        End If
        pos = index(key)
        item = list(pos)
        item(2) = item(2) + r(R_QTY)
        item(3) = item(3) + r(R_AMOUNT)
        list(pos) = item
    Next r
    AggregateByMonthProduct = SortRows(list, count, 1)
End Function

' 「年月」で集計。戻り値は Array(年月, 数量, 金額) の配列。並び順: 年月の昇順
Private Function AggregateByMonth(inRows As Collection) As Variant
    Dim index As Object
    Dim list() As Variant
    Dim count As Long
    Dim r As Variant
    Dim item As Variant
    Dim pos As Long

    Set index = CreateObject("Scripting.Dictionary")
    ReDim list(0 To 0)
    For Each r In inRows
        If Not index.Exists(r(R_YM)) Then
            If count > UBound(list) Then ReDim Preserve list(0 To count * 2)
            list(count) = Array(r(R_YM), 0#, 0#)
            index(r(R_YM)) = count
            count = count + 1
        End If
        pos = index(r(R_YM))
        item = list(pos)
        item(1) = item(1) + r(R_QTY)
        item(2) = item(2) + r(R_AMOUNT)
        list(pos) = item
    Next r
    AggregateByMonth = SortRows(list, count, 2)
End Function

' フォルダ内のファイル名から、読む CSV を選んで並べる（拡張子は大文字・小文字を区別しない。~$ で始まるものは除く）
' 戻り値は 0 から始まる文字列の配列。1 件もなければ UBound が -1 の配列。
Private Function ListCsvFiles(names As Collection) As Variant
    Dim list() As Variant
    Dim count As Long
    Dim name As Variant
    Dim i As Long
    Dim j As Long
    Dim tmp As Variant

    ReDim list(0 To 0)
    For Each name In names
        If Len(name) > 4 Then
            If LCase$(Right$(name, 4)) = ".csv" And Left$(name, 2) <> "~$" Then
                If count > UBound(list) Then ReDim Preserve list(0 To count * 2)
                list(count) = CStr(name)
                count = count + 1
            End If
        End If
    Next name
    If count = 0 Then
        ListCsvFiles = Array()
        Exit Function
    End If
    ReDim Preserve list(0 To count - 1)
    ' ファイルは多くても数十件の想定なので、挿入ソートで十分
    For i = 1 To count - 1
        tmp = list(i)
        j = i - 1
        Do While j >= 0
            If StrComp(list(j), tmp, vbBinaryCompare) <= 0 Then Exit Do
            list(j + 1) = list(j)
            j = j - 1
        Loop
        list(j + 1) = tmp
    Next i
    ListCsvFiles = list
End Function

' ======================================================================
' 補助（Excel・ファイルに関わる処理）
' ======================================================================

Private Function DefaultSettings() As Variant
    DefaultSettings = Array( _
        Array("CSV_FOLDER", "", "CSV を入れたフォルダのパス。空なら実行時にフォルダを選ぶ画面を出す"), _
        Array("ENCODING", ENCODING_AUTO, "CSV の文字コード。自動 / UTF-8 / Shift_JIS。文字化けしたときだけ変える"), _
        Array("COL_DATE", "注文日", "日付の列の見出し名（必須）"), _
        Array("COL_PRODUCT", "商品名", "商品の列の見出し名（必須）"), _
        Array("COL_QUANTITY", "数量", "数量の列の見出し名（必須）"), _
        Array("COL_AMOUNT", "金額", "金額の列の見出し名（必須）。税込の小計など、集計したい金額の列"), _
        Array("COL_ORDER_ID", "注文番号", "注文番号の列の見出し名（任意）。空なら使わない。空にした場合、別のファイルにある同じ内容の行は 1 行にまとめます。1 日分を複数のファイルに分けているなら DEDUPE を FALSE に"), _
        Array("DEDUPE", "TRUE", "TRUE なら、複数の CSV にある同じ行を 1 回だけ数える"), _
        Array("QUOTE_CHECK", "TRUE", "TRUE なら、引用符（""）で囲んだ複数行の値の中に 1 行分以上のデータに見える数のカンマがあるとき、行が消えている可能性としてエラーにする。備考などに本当にカンマの多い複数行の文があってエラーになる場合だけ FALSE にし、その回の集計が終わったら TRUE に戻す"))
End Function

Private Function ReadSettings() As Object
    Dim ws As Worksheet
    Dim result As Object
    Dim lastRow As Long
    Dim r As Long
    Dim key As String
    Dim k As Variant

    Set result = CreateObject("Scripting.Dictionary")
    Set ws = ThisWorkbook.Worksheets(SHEET_SETTINGS)
    lastRow = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    For r = 2 To lastRow
        key = TrimText(CStr(ws.Cells(r, 1).Value))
        If key <> "" And Not result.Exists(key) Then result(key) = TrimText(CStr(ws.Cells(r, 2).Value))
    Next r
    For Each k In Array("CSV_FOLDER", "ENCODING", "COL_DATE", "COL_PRODUCT", "COL_QUANTITY", "COL_AMOUNT", "COL_ORDER_ID", "DEDUPE", "QUOTE_CHECK")
        If Not result.Exists(k) Then result(k) = ""
    Next k
    result("DEDUPE") = UCase$(result("DEDUPE"))
    ' QUOTE_CHECK は版 4 で足したキー。版 3 で作った設定シートにはないので、キーがない・空（空白だけを含む）なら TRUE（検査あり）にする
    result("QUOTE_CHECK") = UCase$(result("QUOTE_CHECK"))
    If result("QUOTE_CHECK") = "" Then result("QUOTE_CHECK") = "TRUE"
    Set ReadSettings = result
End Function

Private Function ValidateSettings(settings As Object) As String
    Dim msg As String
    Dim key As Variant
    For Each key In Array("COL_DATE", "COL_PRODUCT", "COL_QUANTITY", "COL_AMOUNT")
        If settings(key) = "" Then msg = msg & "・" & key & " が空です" & vbCrLf
    Next key
    If settings("ENCODING") <> ENCODING_AUTO And settings("ENCODING") <> ENCODING_UTF8 And settings("ENCODING") <> ENCODING_SJIS Then
        msg = msg & "・ENCODING は「" & ENCODING_AUTO & "」「" & ENCODING_UTF8 & "」「" & ENCODING_SJIS & "」のどれかにしてください" & vbCrLf
    End If
    If settings("DEDUPE") <> "TRUE" And settings("DEDUPE") <> "FALSE" Then
        msg = msg & "・DEDUPE は TRUE か FALSE にしてください" & vbCrLf
    End If
    If settings("QUOTE_CHECK") <> "TRUE" And settings("QUOTE_CHECK") <> "FALSE" Then
        msg = msg & "・QUOTE_CHECK は TRUE か FALSE にしてください" & vbCrLf
    End If
    If msg <> "" Then msg = "「設定」シートを確認してください（キーがない場合は SetupSettings を実行）。" & vbCrLf & msg
    ValidateSettings = msg
End Function

' ファイルをバイト列で読む。読めたら空文字、読めなければ理由を返す。ファイルは変更しない。
Private Function ReadBytes(ByVal path As String, ByRef bytes() As Byte) As String
    Dim st As Object
    Dim v As Variant
    On Error GoTo Failed
    Set st = CreateObject("ADODB.Stream")
    st.Type = 1  ' adTypeBinary
    st.Open
    st.LoadFromFile path
    v = st.Read(-1)  ' adReadAll
    st.Close
    If IsNull(v) Then
        bytes = ""  ' 空のファイル（UBound が -1 の配列になる）
    Else
        bytes = v
    End If
    ReadBytes = ""
    Exit Function
Failed:
    ReadBytes = Err.Description
    On Error Resume Next
    If Not st Is Nothing Then st.Close
End Function

' バイト列を文字列にする。charset は "utf-8" か "shift_jis"
Private Function DecodeBytes(bytes() As Byte, ByVal charset As String) As String
    Dim st As Object
    If UBound(bytes) < LBound(bytes) Then
        DecodeBytes = ""
        Exit Function
    End If
    Set st = CreateObject("ADODB.Stream")
    st.Type = 1  ' adTypeBinary
    st.Open
    st.Write bytes
    st.Position = 0
    st.Type = 2  ' adTypeText（Position が 0 のときだけ変えられる）
    st.Charset = charset
    DecodeBytes = st.ReadText(-1)  ' adReadAll
    st.Close
End Function

Private Function FolderFileNames(fso As Object, ByVal folder As String) As Collection
    Dim names As Collection
    Dim f As Object
    Set names = New Collection
    For Each f In fso.GetFolder(folder).Files
        names.Add CStr(f.Name)
    Next f
    Set FolderFileNames = names
End Function

Private Function PickFolder() As String
    With Application.FileDialog(4)  ' msoFileDialogFolderPicker
        .Title = "CSV を入れたフォルダを選んでください"
        If .Show = -1 Then PickFolder = .SelectedItems(1)
    End With
End Function

Private Function ApplyRemovedCounts(reports As Collection, removedByFile As Object) As Collection
    Dim out As Collection
    Dim rep As Variant
    Dim removed As Long
    Set out = New Collection
    For Each rep In reports
        removed = 0
        If removedByFile.Exists(rep(0)) Then removed = removedByFile(rep(0))
        out.Add Array(rep(0), rep(1), rep(2), rep(3) - removed, removed)
    Next rep
    Set ApplyRemovedCounts = out
End Function

' ---------- 出力 ----------

Private Sub WriteSummary(ws As Worksheet, list As Variant)
    Dim data() As Variant
    Dim i As Long
    ws.Name = "集計"
    If UBound(list) >= 0 Then
        ReDim data(1 To UBound(list) + 1, 1 To 4)
        For i = 0 To UBound(list)
            data(i + 1, 1) = list(i)(0)
            data(i + 1, 2) = list(i)(1)
            data(i + 1, 3) = list(i)(2)
            data(i + 1, 4) = list(i)(3)
        Next i
    End If
    WriteTable ws, Array("年月", "商品", "数量", "金額"), data, UBound(list) + 1, Array(1, 2), Array(3, 4)
End Sub

Private Sub WriteMonthly(ws As Worksheet, list As Variant)
    Dim data() As Variant
    Dim i As Long
    Dim n As Long
    Dim totalQty As Double
    Dim totalAmount As Double
    ws.Name = "月別合計"
    n = UBound(list) + 1
    ReDim data(1 To n + 1, 1 To 3)
    For i = 0 To n - 1
        data(i + 1, 1) = list(i)(0)
        data(i + 1, 2) = list(i)(1)
        data(i + 1, 3) = list(i)(2)
        totalQty = totalQty + list(i)(1)
        totalAmount = totalAmount + list(i)(2)
    Next i
    data(n + 1, 1) = "合計"
    data(n + 1, 2) = totalQty
    data(n + 1, 3) = totalAmount
    WriteTable ws, Array("年月", "数量", "金額"), data, n + 1, Array(1), Array(2, 3)
    ws.Rows(n + 2).Font.Bold = True
End Sub

Private Sub WriteDetails(ws As Worksheet, details As Collection)
    Dim data() As Variant
    Dim r As Variant
    Dim i As Long
    ws.Name = "明細"
    If details.Count > 0 Then
        ReDim data(1 To details.Count, 1 To 8)
        For Each r In details
            i = i + 1
            data(i, 1) = r(R_YM)
            data(i, 2) = r(R_YMD)
            data(i, 3) = r(R_ORDER)
            data(i, 4) = r(R_PRODUCT)
            data(i, 5) = r(R_QTY)
            data(i, 6) = r(R_AMOUNT)
            data(i, 7) = r(R_FILE)
            data(i, 8) = r(R_LINE)
        Next r
    End If
    WriteTable ws, Array("年月", "日付", "注文番号", "商品", "数量", "金額", "元ファイル", "元の行"), data, details.Count, _
               Array(1, 2, 3, 4, 7), Array(5, 6)
End Sub

Private Sub WriteReports(ws As Worksheet, reports As Collection, ByVal folder As String)
    Dim data() As Variant
    Dim rep As Variant
    Dim i As Long
    ws.Name = "取り込み結果"
    ReDim data(1 To reports.Count, 1 To 5)
    For Each rep In reports
        i = i + 1
        data(i, 1) = rep(0)
        data(i, 2) = rep(1)
        data(i, 3) = rep(2)
        data(i, 4) = rep(3)
        data(i, 5) = rep(4)
    Next rep
    WriteTable ws, Array("ファイル", "文字コード", "データ行", "使った行", "重複で除いた行"), data, reports.Count, Array(1, 2), Array(3, 4, 5)
    ' 表の下に、いつ・どのフォルダを集計したかを残す
    ws.Cells(reports.Count + 3, 1).Value = "実行日時"
    ws.Cells(reports.Count + 3, 2).NumberFormat = "@"  ' 日時の文字列が日付の値に変わらないように
    ws.Cells(reports.Count + 3, 2).Value = Format$(Now, "yyyy-mm-dd hh:nn:ss")
    ws.Cells(reports.Count + 4, 1).Value = "フォルダ"
    ws.Cells(reports.Count + 4, 2).NumberFormat = "@"
    ws.Cells(reports.Count + 4, 2).Value = folder
End Sub

Private Sub WriteErrors(ws As Worksheet, errors As Collection)
    Dim data() As Variant
    Dim e As Variant
    Dim i As Long
    ws.Name = "エラー"
    ReDim data(1 To errors.Count, 1 To 3)
    For Each e In errors
        i = i + 1
        data(i, 1) = e(0)
        data(i, 2) = e(1)
        data(i, 3) = e(2)
    Next e
    WriteTable ws, Array("ファイル", "行", "内容"), data, errors.Count, Array(1, 3), Array()
    ws.Columns(2).NumberFormat = "0"
End Sub

' 見出しと表をまとめて書き込む。textCols の列は先に文字列書式にする（"2026-10" が日付に、"0012" が 12 に、
' "=" で始まる値が数式にならないように）。numberCols の列は桁区切りにする。
Private Sub WriteTable(ws As Worksheet, headers As Variant, data As Variant, ByVal rowCount As Long, _
                       textCols As Variant, numberCols As Variant)
    Dim colCount As Long
    Dim c As Variant
    Dim r As Long
    Dim hasFraction As Boolean

    colCount = UBound(headers) - LBound(headers) + 1
    ws.Range(ws.Cells(1, 1), ws.Cells(1, colCount)).Value = headers
    StyleHeader ws.Range(ws.Cells(1, 1), ws.Cells(1, colCount))
    If rowCount > 0 Then
        For Each c In textCols
            ws.Range(ws.Cells(2, c), ws.Cells(rowCount + 1, c)).NumberFormat = "@"
        Next c
        For Each c In numberCols
            hasFraction = False
            For r = 1 To rowCount
                If data(r, c) <> Fix(data(r, c)) Then
                    hasFraction = True
                    Exit For
                End If
            Next r
            If hasFraction Then
                ws.Range(ws.Cells(2, c), ws.Cells(rowCount + 1, c)).NumberFormat = "#,##0.00"
            Else
                ws.Range(ws.Cells(2, c), ws.Cells(rowCount + 1, c)).NumberFormat = "#,##0"
            End If
        Next c
        ws.Range(ws.Cells(2, 1), ws.Cells(rowCount + 1, colCount)).Value = data
    End If
    ws.Columns.AutoFit
    ws.Activate
    FreezeHeaderRow
End Sub

Private Sub StyleHeader(rng As Range)
    rng.Interior.Color = RGB(224, 224, 224)  ' 見出し #e0e0e0
    rng.Font.Bold = True
End Sub

Private Sub FreezeHeaderRow()
    With ActiveWindow
        .FreezePanes = False
        .SplitColumn = 0
        .SplitRow = 1
        .FreezePanes = True
    End With
End Sub

Private Sub SetDropDown(cell As Range, ByVal list As String)
    With cell.Validation
        .Delete
        .Add Type:=xlValidateList, AlertStyle:=xlValidAlertStop, Formula1:=list
    End With
End Sub

Private Function GetOrCreateSheet(wb As Workbook, ByVal name As String) As Worksheet
    If SheetExists(wb, name) Then
        Set GetOrCreateSheet = wb.Worksheets(name)
    Else
        Set GetOrCreateSheet = wb.Worksheets.Add(After:=wb.Worksheets(wb.Worksheets.Count))
        GetOrCreateSheet.Name = name
    End If
End Function

Private Function SheetExists(wb As Workbook, ByVal name As String) As Boolean
    Dim ws As Worksheet
    For Each ws In wb.Worksheets
        If ws.Name = name Then
            SheetExists = True
            Exit Function
        End If
    Next ws
End Function

Private Function FindKeyRow(ws As Worksheet, ByVal key As String) As Long
    Dim lastRow As Long
    Dim r As Long
    lastRow = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    For r = 2 To lastRow
        If TrimText(CStr(ws.Cells(r, 1).Value)) = key Then
            FindKeyRow = r
            Exit Function
        End If
    Next r
End Function

' ---------- 小さな関数 ----------

' 1 文字の UTF-16 コード単位を 0 から 65535 で返す（AscW は 32768 以上を負の数で返すため）
Private Function CodeUnit(ByVal ch As String) As Long
    CodeUnit = AscW(ch) And &HFFFF&
End Function

Private Function IsSpaceChar(ByVal ch As String) As Boolean
    Dim code As Long
    code = CodeUnit(ch)
    IsSpaceChar = (code = 32 Or code = 9 Or code = &H3000&)
End Function

' 全角数字・全角マイナス・全角ピリオドを半角にする
Private Function ToHalfWidthDigits(ByVal s As String) As String
    Dim i As Long
    Dim code As Long
    Dim out As String
    For i = 1 To Len(s)
        code = CodeUnit(Mid$(s, i, 1))
        If code >= &HFF10& And code <= &HFF19& Then
            out = out & ChrW(code - &HFF10& + 48)
        ElseIf code = &HFF0D& Or code = &H2212& Then
            out = out & "-"
        ElseIf code = &HFF0E& Then
            out = out & "."
        Else
            out = out & Mid$(s, i, 1)
        End If
    Next i
    ToHalfWidthDigits = out
End Function

' "-?数字(.数字)?" の形か
Private Function IsNumberText(ByVal s As String) As Boolean
    Dim i As Long
    Dim startPos As Long
    Dim code As Long
    Dim before As Long
    Dim after As Long
    Dim seenDot As Boolean
    startPos = 1
    If Left$(s, 1) = "-" Then startPos = 2
    For i = startPos To Len(s)
        code = CodeUnit(Mid$(s, i, 1))
        If code >= 48 And code <= 57 Then
            If seenDot Then after = after + 1 Else before = before + 1
        ElseIf code = 46 And Not seenDot Then
            seenDot = True
        Else
            Exit Function
        End If
    Next i
    If before = 0 Then Exit Function
    If seenDot And after = 0 Then Exit Function
    IsNumberText = True
End Function

' 文字列の中の文字 ch の数
Private Function CountChar(ByVal s As String, ByVal ch As String) As Long
    Dim p As Long
    p = InStr(1, s, ch, vbBinaryCompare)
    Do While p > 0
        CountChar = CountChar + 1
        p = InStr(p + 1, s, ch, vbBinaryCompare)
    Loop
End Function

Private Function IsDigits(ByVal s As String) As Boolean
    Dim i As Long
    Dim code As Long
    If Len(s) = 0 Then Exit Function
    For i = 1 To Len(s)
        code = CodeUnit(Mid$(s, i, 1))
        If code < 48 Or code > 57 Then Exit Function
    Next i
    IsDigits = True
End Function

Private Function DaysInMonth(ByVal y As Long, ByVal m As Long) As Long
    Select Case m
        Case 2
            If (y Mod 4 = 0 And y Mod 100 <> 0) Or y Mod 400 = 0 Then DaysInMonth = 29 Else DaysInMonth = 28
        Case 4, 6, 9, 11
            DaysInMonth = 30
        Case Else
            DaysInMonth = 31
    End Select
End Function

Private Function NumberError(ByVal colName As String, ByVal raw As String) As String
    If TrimText(raw) = "" Then
        NumberError = "「" & colName & "」が空です"
    Else
        NumberError = "「" & colName & "」を数値として読めません: " & TrimText(raw)
    End If
End Function

Private Function IsBlankRecord(fields As Variant) As Boolean
    Dim i As Long
    For i = LBound(fields) To UBound(fields)
        If TrimText(CStr(fields(i))) <> "" Then Exit Function
    Next i
    IsBlankRecord = True
End Function

Private Function FieldAt(fields As Variant, ByVal idx As Long) As String
    If idx >= 0 And idx <= UBound(fields) - LBound(fields) Then FieldAt = CStr(fields(LBound(fields) + idx))
End Function

Private Function CollectionToArray(c As Collection) As Variant
    Dim arr() As Variant
    Dim i As Long
    Dim v As Variant
    ReDim arr(0 To c.Count - 1)
    For Each v In c
        arr(i) = v
        i = i + 1
    Next v
    CollectionToArray = arr
End Function

' 集計結果の並べ替え（クイックソート）。mode 1: 年月 → 金額の降順 → 商品、mode 2: 年月
' list の 0 から count - 1 までを並べ、その長さの配列を返す。
Private Function SortRows(list() As Variant, ByVal count As Long, ByVal mode As Long) As Variant
    Dim out() As Variant
    Dim i As Long
    If count = 0 Then
        SortRows = Array()
        Exit Function
    End If
    ReDim out(0 To count - 1)
    For i = 0 To count - 1
        out(i) = list(i)
    Next i
    QuickSort out, 0, count - 1, mode
    SortRows = out
End Function

Private Sub QuickSort(arr() As Variant, ByVal lo As Long, ByVal hi As Long, ByVal mode As Long)
    Dim i As Long
    Dim j As Long
    Dim pivot As Variant
    Dim tmp As Variant
    If lo >= hi Then Exit Sub
    pivot = arr((lo + hi) \ 2)
    i = lo
    j = hi
    Do While i <= j
        Do While CompareRows(arr(i), pivot, mode) < 0
            i = i + 1
        Loop
        Do While CompareRows(arr(j), pivot, mode) > 0
            j = j - 1
        Loop
        If i <= j Then
            tmp = arr(i)
            arr(i) = arr(j)
            arr(j) = tmp
            i = i + 1
            j = j - 1
        End If
    Loop
    If lo < j Then QuickSort arr, lo, j, mode
    If i < hi Then QuickSort arr, i, hi, mode
End Sub

Private Function CompareRows(a As Variant, b As Variant, ByVal mode As Long) As Long
    CompareRows = StrComp(a(0), b(0), vbBinaryCompare)
    If CompareRows <> 0 Or mode = 2 Then Exit Function
    If a(3) > b(3) Then
        CompareRows = -1
    ElseIf a(3) < b(3) Then
        CompareRows = 1
    Else
        CompareRows = StrComp(a(1), b(1), vbBinaryCompare)
    End If
End Function
