@echo off

set SOURCE_DIR=%~dp0
set SOURCE_DIR=%SOURCE_DIR:~0,-1%
set LOCAL_BUILD=%TEMP%\java_build_%~n0_%COMPUTERNAME%

mkdir "%LOCAL_BUILD%" 2>nul

echo Copying source files...
for %%D in (Display SheetHandler Parser Parts) do (
    if exist "%SOURCE_DIR%\%%D" (
        mkdir "%LOCAL_BUILD%\%%D" 2>nul
        xcopy /s /y "%SOURCE_DIR%\%%D\*" "%LOCAL_BUILD%\%%D\" >nul
    )
)

for %%F in ("%SOURCE_DIR%\"*.java) do (
    if exist "%%~fF" copy /y "%%~fF" "%LOCAL_BUILD%\" >nul
)

cd /d "%LOCAL_BUILD%"
for /r %%f in (*.class) do del /q "%%f" >nul 2>&1

echo Compiling...
javac -cp . Runner.java JustinProg.java
if %errorlevel% neq 0 (
    echo Build failed
    exit /b 1
)

echo Build successful, launching...
cd /d "%SOURCE_DIR%"
java -cp "%LOCAL_BUILD%" Runner

timeout /t 2 >nul
rmdir /s /q "%LOCAL_BUILD%" >nul 2>&1
echo Done