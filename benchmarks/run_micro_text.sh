#!/bin/bash

if [ -z "$4" ]
then
  echo "Usage: ./run_all.sh <out folder> <version> <warmup trials> <recorded trials> [--oursOnly | --othersOnly]"
  echo "If --oursOnly is set, only our library's tests are run."
  echo "If --othersOnly is set, only other libraries' tests are run."
  exit 1
fi

if [ ! -z $5 ] && [ $5 == "--oursOnly" ]
then
  which="ours"
elif [ ! -z $5 ] && [ $5 == "--othersOnly" ]
then
  which="others"
else
  which="all"
fi

echo "Which implementations: $which"

# Suffixes refer to Mode. Multi refers to rotate & concurrent modes.
function setImpls {
  if [ $which == "ours" ]
  then
    implsSingle=("${oursSingle[@]}")
    implsMulti=("${oursMulti[@]}")
  elif [ $which == "others" ]
  then
    implsSingle=("${othersSingle[@]}")
    implsMulti=("${othersMulti[@]}")
  else
    implsSingle=("${oursSingle[@]}" "${othersSingle[@]}")
    implsMulti=("${oursMulti[@]}" "${othersMulti[@]}")
  fi
}

in1=$1
in2=$2
in3=$3
in4=$4

function go {
  setImpls
  for implementation in ${implsSingle[*]}
  do
    for measurement in "sendTime" "sendMemory" "receiveAll"
    do
      npm start -- $in1 $in2 $in3 $in4 $measurement $trace $implementation single
    done
  done
  for implementation in ${implsMulti[*]}
  do
    for mode in "rotate" "concurrent"
    do
      for measurement in "receiveAll"
      do
        npm start -- $in1 $in2 $in3 $in4 $measurement $trace $implementation $mode
      done
    done
  done
}

trace="MicroTextLtr"
oursSingle=("CollabsText")
oursMulti=("CollabsText" "CollabsCGText")
othersSingle=("AutomergeText" "YjsText")
othersMulti=("YjsText")
go

trace="MicroTextRandom"
go